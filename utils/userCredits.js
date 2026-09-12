/**
 * User Credits Manager
 *
 * Handles user-level credit operations for AI/LLM usage tracking.
 * Provides atomic operations to prevent race conditions during concurrent usage.
 *
 * Design Principles:
 * - All credit modifications use atomic MongoDB operations
 * - Credits cannot go negative (enforced at DB level via min: 0)
 * - Every operation is logged for audit purposes
 * - Designed to work alongside team-level credits (creditManager.js)
 *
 * Usage Flow for AI Calls:
 * 1. checkCredits() - Verify user has sufficient credits before LLM call
 * 2. Make LLM call
 * 3. deductCredits() - Deduct actual cost after call completes
 *
 * Credit Sources:
 * - User's personal balance (token_credit_balance)
 * - Team pool (future: via team_account_id or defaultTeamId)
 */

import { User } from "../models/user.js";
import {
  addCreditLot,
  deductFromLots,
  expireAndSyncBalance,
  getCreditLedger,
  setBalanceViaLots,
} from "./creditLots.js";

// ============================================================================
// Credit Balance Operations
// ============================================================================

/**
 * Get a user's current credit balance
 * @param {string|ObjectId} userId - User ID
 * @returns {Promise<{success: boolean, balance?: number, error?: string}>}
 */
export async function getCreditBalance(userId) {
  if (!userId) {
    return { success: false, error: "User ID is required" };
  }

  try {
    const synced = await expireAndSyncBalance(userId);
    if (!synced.success) {
      return { success: false, error: synced.error || "User not found" };
    }
    return {
      success: true,
      balance: synced.balance,
    };
  } catch (error) {
    console.error("[UserCredits] Get balance error:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Check if a user has sufficient credits for an operation
 * @param {string|ObjectId} userId - User ID
 * @param {number} requiredAmount - Amount of credits needed
 * @returns {Promise<{sufficient: boolean, balance?: number, shortfall?: number, error?: string}>}
 */
export async function checkCredits(userId, requiredAmount) {
  if (!userId) {
    return { sufficient: false, error: "User ID is required" };
  }

  if (typeof requiredAmount !== "number" || requiredAmount < 0) {
    return { sufficient: false, error: "Invalid required amount" };
  }

  try {
    const synced = await expireAndSyncBalance(userId);
    if (!synced.success) {
      return { sufficient: false, error: synced.error || "User not found" };
    }

    const balance = synced.balance;
    const sufficient = balance >= requiredAmount;

    return {
      sufficient,
      balance,
      shortfall: sufficient ? 0 : requiredAmount - balance,
    };
  } catch (error) {
    console.error("[UserCredits] Check credits error:", error.message);
    return { sufficient: false, error: error.message };
  }
}

/**
 * Add credits to a user's balance (for purchases, grants, refunds)
 * Uses atomic operation to prevent race conditions
 *
 * @param {string|ObjectId} userId - User ID
 * @param {number} amount - Amount to add (must be positive)
 * @param {Object} options - Additional options
 * @param {string} options.reason - Reason for credit addition (for audit)
 * @param {string} options.source - Source of credits (purchase, grant, refund, etc.)
 * @param {string} options.operatorId - ID of user/system performing the operation
 * @returns {Promise<{success: boolean, newBalance?: number, previousBalance?: number, error?: string}>}
 */
export async function addCredits(userId, amount, options = {}) {
  if (!userId) {
    return { success: false, error: "User ID is required" };
  }

  if (typeof amount !== "number" || amount <= 0) {
    return { success: false, error: "Amount must be a positive number" };
  }

  const {
    reason = "Credit addition",
    source = "manual",
    operatorId = null,
    invoiceId,
    purchaseMethod,
  } = options;

  try {
    const added = await addCreditLot(userId, amount, {
      invoiceId,
      source,
      purchaseMethod: purchaseMethod || reason,
      billingReason: reason,
    });
    if (!added.granted) {
      return { success: false, error: added.error || "Failed to add credits" };
    }

    console.log(
      `[UserCredits] Added ${amount} credits to user ${userId}: ${added.previousBalance} → ${added.newBalance} (${source}: ${reason})${
        operatorId ? ` [by ${operatorId}]` : ""
      }`,
    );

    return {
      success: true,
      previousBalance: added.previousBalance,
      newBalance: added.newBalance,
      amountAdded: amount,
      expiresAt: added.expiresAt,
      source,
      reason,
    };
  } catch (error) {
    console.error("[UserCredits] Add credits error:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Deduct credits from a user's balance (for AI usage)
 * Uses atomic operation with balance check to prevent overdraft
 *
 * @param {string|ObjectId} userId - User ID
 * @param {number} amount - Amount to deduct (must be positive)
 * @param {Object} options - Additional options
 * @param {string} options.reason - Reason for deduction (for audit)
 * @param {string} options.callType - Type of AI call (email-processing, chat, etc.)
 * @param {string} options.projectId - Associated project ID
 * @returns {Promise<{success: boolean, newBalance?: number, previousBalance?: number, error?: string}>}
 */
export async function deductCredits(userId, amount, options = {}) {
  if (!userId) {
    return { success: false, error: "User ID is required" };
  }

  if (typeof amount !== "number" || amount <= 0) {
    return { success: false, error: "Amount must be a positive number" };
  }

  const {
    reason = "AI usage",
    callType = "unknown",
    projectId = null,
  } = options;

  try {
    const deducted = await deductFromLots(userId, amount, {
      reason,
      callType,
      projectId,
    });
    if (!deducted.success) return deducted;

    console.log(
      `[UserCredits] Deducted ${amount} credits from user ${userId}: ${deducted.previousBalance} → ${deducted.newBalance} (${callType}: ${reason})${
        projectId ? ` [project: ${projectId}]` : ""
      }`,
    );

    return deducted;
  } catch (error) {
    console.error("[UserCredits] Deduct credits error:", error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Set a user's credit balance to a specific value
 * Use sparingly - prefer add/deduct for audit trail
 *
 * @param {string|ObjectId} userId - User ID
 * @param {number} newBalance - New balance to set (must be >= 0)
 * @param {Object} options - Additional options
 * @param {string} options.reason - Reason for setting balance
 * @param {string} options.operatorId - ID of user/system performing the operation
 * @returns {Promise<{success: boolean, newBalance?: number, previousBalance?: number, error?: string}>}
 */
export async function setCredits(userId, newBalance, options = {}) {
  if (!userId) {
    return { success: false, error: "User ID is required" };
  }

  if (typeof newBalance !== "number" || newBalance < 0) {
    return { success: false, error: "Balance must be a non-negative number" };
  }

  const { reason = "Balance adjustment", operatorId = null } = options;

  try {
    const result = await setBalanceViaLots(userId, newBalance, {
      reason,
      operatorId,
      source: "admin",
    });
    if (!result.success) return result;

    console.log(
      `[UserCredits] Set credits for user ${userId}: ${result.previousBalance} → ${result.newBalance} (${reason})${
        operatorId ? ` [by ${operatorId}]` : ""
      }`,
    );

    return result;
  } catch (error) {
    console.error("[UserCredits] Set credits error:", error.message);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// Login & Initialization Operations
// ============================================================================

/**
 * Ensure a user has a credit balance record initialized
 * Called at login to guarantee the field exists with a valid value
 *
 * @param {string|ObjectId} userId - User ID
 * @returns {Promise<{success: boolean, balance: number, initialized?: boolean, error?: string}>}
 */
export async function ensureCreditBalance(userId) {
  if (!userId) {
    return { success: false, error: "User ID is required", balance: 0 };
  }

  try {
    const user = await User.findById(userId)
      .select("token_credit_balance")
      .lean();

    if (!user) {
      return { success: false, error: "User not found", balance: 0 };
    }

    // Check if balance needs initialization
    if (
      user.token_credit_balance === undefined ||
      user.token_credit_balance === null
    ) {
      // Initialize to 0
      await User.findByIdAndUpdate(userId, {
        $set: { token_credit_balance: 0 },
      });

      console.log(
        `[UserCredits] Initialized credit balance for user ${userId} to 0`,
      );

      return {
        success: true,
        balance: 0,
        initialized: true,
      };
    }

    return {
      success: true,
      balance: user.token_credit_balance,
      initialized: false,
    };
  } catch (error) {
    console.error("[UserCredits] Ensure balance error:", error.message);
    return { success: false, error: error.message, balance: 0 };
  }
}

/**
 * Get user credit info for display (login response, UI updates)
 * Returns all credit-related fields a user needs to see
 *
 * @param {string|ObjectId} userId - User ID
 * @returns {Promise<{success: boolean, credits?: Object, error?: string}>}
 */
export async function getUserCreditInfo(userId) {
  if (!userId) {
    return { success: false, error: "User ID is required" };
  }

  try {
    const user = await User.findById(userId)
      .select("token_credit_balance defaultTeamId team_account_id")
      .lean();

    if (!user) {
      return { success: false, error: "User not found" };
    }

    const ledger = await getCreditLedger(userId);
    const balance = ledger.success ? ledger.balance : user.token_credit_balance ?? 0;

    return {
      success: true,
      credits: {
        balance,
        hasTeam: !!(user.defaultTeamId || user.team_account_id),
        expiryDays: 30,
        totals: ledger.totals || null,
        nextExpiration: ledger.nextExpiration || null,
      },
    };
  } catch (error) {
    console.error("[UserCredits] Get credit info error:", error.message);
    return { success: false, error: error.message };
  }
}

// ============================================================================
// Export all functions
// ============================================================================

export default {
  getCreditBalance,
  checkCredits,
  addCredits,
  deductCredits,
  setCredits,
  ensureCreditBalance,
  getUserCreditInfo,
};
