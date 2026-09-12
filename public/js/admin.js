import { getAuthToken, ensureValidSession } from "./auth.js";

const apiBase = String(
  (typeof AppConfig !== "undefined" && AppConfig?.apiBaseUrl) || "",
).replace(/\/+$/, "");

const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});
const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const PLAN_LABELS = { free: "Free", pro: "Paid" };
const PLAN_ORDER = ["free", "pro"];
const ACTIVITY_PAGE_SIZE = 20;
const USER_TABLE_COLUMN_COUNT = 15;

const ACTIVITY_SOURCE_LABELS = {
  admin: "Admin",
  admin_manual_credit: "Admin credit",
  stripe_webhook: "Stripe webhook",
};

const ACTIVITY_EVENT_LABELS = {
  manual_credit_granted: "Manual credits granted",
  manual_credit_adjusted: "Credits adjusted",
  billing_invoice_paid: "Invoice paid",
  credit_topup_purchased: "Credit top-up",
  admin_message_sent: "Message sent",
  message_all_sent: "Message to all users",
  user_deleted: "User deleted",
  subscription_tier_overridden: "Plan overridden",
};

const DELETE_CONFIRMATION_WORD = "DELETE";

const CHART_COLORS = [
  "#ffb703",
  "#3ee0d4",
  "#6ea8ff",
  "#ff4fa3",
  "#c6ff4a",
  "#ff6b6b",
  "#7c3aed",
  "#0891b2",
];

const elements = {
  backButton: document.getElementById("adminBackButton"),
  refreshButton: document.getElementById("adminRefreshButton"),
  statusMessage: document.getElementById("adminStatusMessage"),
  usersTableBody: document.getElementById("adminUsersTableBody"),
  usersSearch: document.getElementById("adminUsersSearch"),
  userSortButtons: Array.from(
    document.querySelectorAll(".admin-users-table .admin-sort-button"),
  ),
  totalUsers: document.getElementById("adminTotalUsers"),
  proSubscribers: document.getElementById("adminProSubscribers"),
  freeUsers: document.getElementById("adminFreeUsers"),
  unverifiedUsers: document.getElementById("adminUnverifiedUsers"),
  totalCredits: document.getElementById("adminTotalCredits"),
  totalCreditsPurchased: document.getElementById("adminTotalCreditsPurchased"),
  totalCreditsUsed: document.getElementById("adminTotalCreditsUsed"),
  totalCreditsExpired: document.getElementById("adminTotalCreditsExpired"),
  totalCreditsExpiring: document.getElementById("adminTotalCreditsExpiring"),
  totalPlaybooks: document.getElementById("adminTotalPlaybooks"),
  creditLots: document.getElementById("adminCreditLots"),
  modelUsageStatus: document.getElementById("adminModelUsageStatus"),
  modelUsageStats: document.getElementById("adminModelUsageStats"),
  modelUsageSummary: document.getElementById("adminModelUsageSummary"),
  modelUsagePeriodLabel: document.getElementById("adminModelUsagePeriodLabel"),
  modelUsagePrev: document.getElementById("adminModelUsagePrev"),
  modelUsageNext: document.getElementById("adminModelUsageNext"),
  modelUsageChart: document.getElementById("adminModelUsageChart"),
  modelUsageRangeButtons: Array.from(
    document.querySelectorAll(".admin-model-usage-range-btn"),
  ),
  modelUsageChartTypeButtons: Array.from(
    document.querySelectorAll(".admin-model-usage-chart-type-btn"),
  ),
  plansGrid: document.getElementById("adminPlansGrid"),
  modalBackdrop: document.getElementById("adminModalBackdrop"),
  addCreditsModal: document.getElementById("adminAddCreditsModal"),
  addCreditsForm: document.getElementById("adminAddCreditsForm"),
  addCreditsTitle: document.getElementById("adminAddCreditsTitle"),
  addCreditsCurrent: document.getElementById("adminAddCreditsCurrent"),
  addCreditsAmount: document.getElementById("adminAddCreditsAmount"),
  addCreditsMessage: document.getElementById("adminAddCreditsMessage"),
  addCreditsError: document.getElementById("adminAddCreditsError"),
  addCreditsCancel: document.getElementById("adminAddCreditsCancel"),
  changePlanModal: document.getElementById("adminChangePlanModal"),
  changePlanForm: document.getElementById("adminChangePlanForm"),
  changePlanTitle: document.getElementById("adminChangePlanTitle"),
  changePlanDescription: document.getElementById("adminChangePlanDescription"),
  changePlanSelect: document.getElementById("adminChangePlanSelect"),
  changePlanError: document.getElementById("adminChangePlanError"),
  changePlanCancel: document.getElementById("adminChangePlanCancel"),
  messageUserModal: document.getElementById("adminMessageUserModal"),
  messageUserTitle: document.getElementById("adminMessageUserTitle"),
  messageUserForm: document.getElementById("adminMessageUserForm"),
  messageSubject: document.getElementById("adminMessageSubject"),
  messageBody: document.getElementById("adminMessageBody"),
  messageCopy: document.getElementById("adminMessageCopy"),
  messageUserError: document.getElementById("adminMessageUserError"),
  messageUserCancel: document.getElementById("adminMessageUserCancel"),
  deleteUserModal: document.getElementById("adminDeleteUserModal"),
  deleteUserForm: document.getElementById("adminDeleteUserForm"),
  deleteUserTitle: document.getElementById("adminDeleteUserTitle"),
  deleteUserDescription: document.getElementById("adminDeleteUserDescription"),
  deleteUserConfirm: document.getElementById("adminDeleteUserConfirm"),
  deleteUserError: document.getElementById("adminDeleteUserError"),
  deleteUserCancel: document.getElementById("adminDeleteUserCancel"),
  deleteUserSubmit: document.getElementById("adminDeleteUserSubmit"),
  recentActivityBody: document.getElementById("adminRecentActivityTableBody"),
  recentActivityEmpty: document.getElementById("adminRecentActivityEmpty"),
  recentActivityPrev: document.getElementById("adminRecentActivityPrev"),
  recentActivityNext: document.getElementById("adminRecentActivityNext"),
  recentActivityPageLabel: document.getElementById("adminRecentActivityPageLabel"),
  messageAllButton: document.getElementById("adminMessageAllButton"),
  messageAllModal: document.getElementById("adminMessageAllModal"),
  messageAllForm: document.getElementById("adminMessageAllForm"),
  messageAllSubject: document.getElementById("adminMessageAllSubject"),
  messageAllBody: document.getElementById("adminMessageAllBody"),
  messageAllAiPrompt: document.getElementById("adminMessageAllAiPrompt"),
  messageAllAiModel: document.getElementById("adminMessageAllAiModel"),
  messageAllAiGenerate: document.getElementById("adminMessageAllAiGenerate"),
  messageAllError: document.getElementById("adminMessageAllError"),
  messageAllProgress: document.getElementById("adminMessageAllProgress"),
  messageAllCancel: document.getElementById("adminMessageAllCancel"),
};

const state = {
  usersById: new Map(),
  selectedUserId: null,
  activeModal: null,
  addCreditsMessageDirty: false,
  selectedUserEmail: "",
  deleteConfirmationValue: "",
  recentActivity: [],
  recentActivityPage: 1,
  modelUsageRange: "month",
  modelUsageAnchor: new Date(),
  modelUsageChartType: "bar",
  modelUsageData: null,
  modelUsageLoading: false,
  modelUsageChartInstance: null,
  dashboardUsers: [],
  userSort: { key: "credits", direction: "desc" },
  userSearchQuery: "",
};

const USER_SORT_COLUMNS = {
  name: { getValue: (user) => String(user?.name || "").toLowerCase(), type: "string" },
  email: { getValue: (user) => String(user?.email || "").toLowerCase(), type: "string" },
  plan: {
    getValue: (user) =>
      String(user?.subscription?.tier || user?.subscriptionTier || "free").toLowerCase(),
    type: "string",
  },
  subscription: {
    getValue: (user) => String(user?.subscription?.status || "").toLowerCase(),
    type: "string",
  },
  credits: { getValue: (user) => Number(user?.credits) || 0, type: "number" },
  creditsPurchased: { getValue: (user) => Number(user?.creditsPurchased) || 0, type: "number" },
  creditsUsed: { getValue: (user) => Number(user?.creditsUsed) || 0, type: "number" },
  creditsExpired: { getValue: (user) => Number(user?.creditsExpired) || 0, type: "number" },
  creditsExpiring: { getValue: (user) => Number(user?.creditsExpiring) || 0, type: "number" },
  nextExpiration: {
    getValue: (user) => (user?.nextExpiration ? new Date(user.nextExpiration).getTime() : 0),
    type: "number",
  },
  sessions: { getValue: (user) => Number(user?.sessions ?? user?.playbooks) || 0, type: "number" },
  playbooks: { getValue: (user) => Number(user?.sessions ?? user?.playbooks) || 0, type: "number" },
  lastActive: {
    getValue: (user) => (user?.lastActiveAt ? new Date(user.lastActiveAt).getTime() : 0),
    type: "number",
  },
};

function apiUrl(path) {
  return `${apiBase}${path}`;
}

async function authFetch(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getAuthToken();
  if (token && !headers.has("x-auth-token")) headers.set("x-auth-token", token);
  let response = await fetch(apiUrl(path), {
    ...options,
    credentials: "include",
    headers,
  });
  if (response.status === 401) {
    const ok = await ensureValidSession();
    if (!ok) {
      window.location.href = "/index.html";
      throw Object.assign(new Error("unauthorized"), { status: 401 });
    }
    headers.set("x-auth-token", getAuthToken());
    response = await fetch(apiUrl(path), {
      ...options,
      credentials: "include",
      headers,
    });
  }
  return response;
}

function throwIfAuthError(response) {
  if (response.status === 401) {
    throw Object.assign(new Error("unauthorized"), { status: 401 });
  }
  if (response.status === 403) {
    throw Object.assign(new Error("forbidden"), { status: 403 });
  }
}

async function parseErrorMessage(response, fallback) {
  try {
    const data = await response.json();
    if (data?.error || data?.message) return data.error || data.message;
  } catch {
    // ignore
  }
  return fallback;
}

async function sendJson(path, payload, method = "POST") {
  const response = await authFetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  throwIfAuthError(response);
  if (!response.ok) {
    throw Object.assign(new Error(await parseErrorMessage(response, "Request failed.")), {
      status: response.status,
    });
  }
  return response.status === 204 ? null : response.json();
}

async function postJson(path, payload) {
  return sendJson(path, payload, "POST");
}

function formatNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numberFormatter.format(numeric) : "0";
}

function formatDate(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return dateFormatter.format(date);
}

function formatDateTime(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return dateTimeFormatter.format(date);
}

function updateStatus(message, type = "info") {
  if (!elements.statusMessage) return;
  if (!message) {
    elements.statusMessage.textContent = "";
    elements.statusMessage.classList.add("is-hidden");
    elements.statusMessage.classList.remove("is-error");
    return;
  }
  elements.statusMessage.textContent = message;
  elements.statusMessage.classList.remove("is-hidden");
  elements.statusMessage.classList.toggle("is-error", type === "error");
}

function openModal(modal) {
  if (!modal) return;
  modal.classList.remove("is-hidden");
  elements.modalBackdrop?.classList.remove("is-hidden");
  state.activeModal = modal;
}

function setModalError(element, message) {
  if (!element) return;
  element.textContent = message || "";
}

function closeModal() {
  if (state.activeModal === elements.deleteUserModal) {
    elements.deleteUserForm?.reset();
    setModalError(elements.deleteUserError, "");
    state.deleteConfirmationValue = "";
    state.selectedUserEmail = "";
  }
  if (state.activeModal === elements.changePlanModal) {
    elements.changePlanForm?.reset();
    setModalError(elements.changePlanError, "");
  }
  if (state.activeModal === elements.addCreditsModal) {
    setModalError(elements.addCreditsError, "");
  }
  state.activeModal?.classList.add("is-hidden");
  state.activeModal = null;
  elements.modalBackdrop?.classList.add("is-hidden");
}

function isPrivileged(user) {
  return Boolean(user?.roles?.isAdmin || user?.roles?.isDev);
}

function getVisibleUsers() {
  const query = state.userSearchQuery.trim().toLowerCase();
  let users = state.dashboardUsers.slice();
  if (query) {
    users = users.filter((user) => {
      const name = String(user?.name || "").toLowerCase();
      const email = String(user?.email || "").toLowerCase();
      return name.includes(query) || email.includes(query);
    });
  }
  const column = USER_SORT_COLUMNS[state.userSort.key];
  if (!column) return users;
  const direction = state.userSort.direction === "asc" ? 1 : -1;
  users.sort((a, b) => {
    const av = column.getValue(a);
    const bv = column.getValue(b);
    if (column.type === "number") return (av - bv) * direction;
    return String(av).localeCompare(String(bv)) * direction;
  });
  return users;
}

function updateUserSortIndicators() {
  elements.userSortButtons.forEach((button) => {
    const active = button.dataset.sortKey === state.userSort.key;
    button.classList.toggle("is-active", active);
    const indicator = button.querySelector(".admin-sort-indicator");
    if (indicator) {
      indicator.textContent = active
        ? state.userSort.direction === "asc"
          ? "▲"
          : "▼"
        : "";
    }
  });
}

function setUserSort(key) {
  if (state.userSort.key === key) {
    state.userSort.direction = state.userSort.direction === "asc" ? "desc" : "asc";
  } else {
    state.userSort = {
      key,
      direction: USER_SORT_COLUMNS[key]?.type === "string" ? "asc" : "desc",
    };
  }
  updateUserSortIndicators();
  renderUsers(getVisibleUsers());
}

function closeMenus() {
  document.querySelectorAll(".admin-tier-picker, .admin-kebab-menu").forEach((el) => el.remove());
}

function positionFloatingMenu(menu, anchorEl, { align = "right" } = {}) {
  document.body.appendChild(menu);
  menu.classList.add("admin-floating-menu");
  const rect = anchorEl.getBoundingClientRect();
  const menuWidth = Math.max(menu.offsetWidth, 160);
  const menuHeight = menu.offsetHeight;
  const gap = 4;
  const spaceBelow = window.innerHeight - rect.bottom;
  const openUp = spaceBelow < menuHeight + gap + 8 && rect.top > menuHeight + gap;
  let top = openUp ? rect.top - menuHeight - gap : rect.bottom + gap;
  let left = align === "left" ? rect.left : rect.right - menuWidth;
  left = Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - menuHeight - 8));
  menu.style.position = "fixed";
  menu.style.top = `${Math.round(top)}px`;
  menu.style.left = `${Math.round(left)}px`;
  menu.style.right = "auto";
}

function bindMenuDismiss(menu, anchorEl) {
  const dismiss = () => {
    if (document.body.contains(menu)) menu.remove();
    document.removeEventListener("click", closeOnOutside, true);
    window.removeEventListener("resize", dismiss);
    window.removeEventListener("scroll", dismiss, true);
  };
  const closeOnOutside = (event) => {
    if (!menu.contains(event.target) && event.target !== anchorEl) dismiss();
  };
  setTimeout(() => {
    document.addEventListener("click", closeOnOutside, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
  }, 0);
}

async function updateUserPlan(userId, tier) {
  const response = await authFetch(`/api/admin/users/${encodeURIComponent(userId)}/tier`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tier }),
  });
  throwIfAuthError(response);
  if (!response.ok) {
    throw new Error(await parseErrorMessage(response, "Unable to update plan."));
  }
}

function openTierPicker(anchorEl, userId, currentTier) {
  closeMenus();
  const picker = document.createElement("div");
  picker.className = "admin-tier-picker";
  PLAN_ORDER.forEach((tier) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "admin-tier-picker-item";
    if (tier === currentTier) btn.classList.add("is-current");
    btn.textContent = PLAN_LABELS[tier] || tier;
    btn.addEventListener("click", async () => {
      picker.remove();
      if (tier === currentTier) return;
      try {
        await updateUserPlan(userId, tier);
        await loadDashboard();
      } catch (error) {
        handleAuthRedirect(error);
        updateStatus(error.message || "Unable to update plan.", "error");
      }
    });
    picker.appendChild(btn);
  });
  positionFloatingMenu(picker, anchorEl, { align: "left" });
  bindMenuDismiss(picker, anchorEl);
}

function openKebabMenu(anchorEl, userId, user) {
  closeMenus();
  const menu = document.createElement("div");
  menu.className = "admin-kebab-menu";
  const privileged = isPrivileged(user);
  const items = [
    { label: "Message", onClick: () => openMessageUserDialog(userId) },
    { label: "Change plan", onClick: () => openChangePlanDialog(userId) },
    { label: "Modify credits", onClick: () => openAddCreditsDialog(userId) },
    {
      label: "Delete",
      danger: true,
      disabled: privileged,
      onClick: () => openDeleteUserDialog(userId),
    },
  ];
  items.forEach((item) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `admin-kebab-menu-item${item.danger ? " admin-kebab-menu-item--danger" : ""}`;
    btn.textContent = item.label;
    btn.disabled = Boolean(item.disabled);
    btn.addEventListener("click", () => {
      menu.remove();
      item.onClick();
    });
    menu.appendChild(btn);
  });
  positionFloatingMenu(menu, anchorEl, { align: "right" });
  bindMenuDismiss(menu, anchorEl);
}

function renderUsers(users) {
  if (!elements.usersTableBody) return;
  elements.usersTableBody.innerHTML = "";
  state.usersById = new Map();
  if (!users.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = USER_TABLE_COLUMN_COUNT;
    cell.className = "admin-table-empty";
    cell.textContent = state.userSearchQuery
      ? "No users match that search."
      : "No users found.";
    row.appendChild(cell);
    elements.usersTableBody.appendChild(row);
    return;
  }

  users.forEach((user) => {
    const userId = String(user.id);
    state.usersById.set(userId, user);
    const row = document.createElement("tr");
    if (isPrivileged(user)) row.classList.add("admin-row-privileged");

    const nameCell = document.createElement("td");
    const nameWrap = document.createElement("div");
    nameWrap.className = "admin-user-cell";
    const name = document.createElement("span");
    name.className = "admin-user-name";
    name.textContent = user.name || "Unnamed";
    nameWrap.appendChild(name);
    if (user.roles?.isAdmin) {
      const badge = document.createElement("span");
      badge.className = "admin-role-badge";
      badge.textContent = "Admin";
      nameWrap.appendChild(badge);
    }
    if (user.roles?.isDev) {
      const badge = document.createElement("span");
      badge.className = "admin-role-badge";
      badge.textContent = "Dev";
      nameWrap.appendChild(badge);
    }
    nameCell.appendChild(nameWrap);
    row.appendChild(nameCell);

    const emailCell = document.createElement("td");
    emailCell.textContent = user.email || "";
    row.appendChild(emailCell);

    const verifiedCell = document.createElement("td");
    const verified = document.createElement("span");
    verified.className = `admin-verified-badge ${
      user.emailValidated
        ? "admin-verified-badge--verified"
        : "admin-verified-badge--pending"
    }`;
    verified.textContent = user.emailValidated ? "Yes" : "Pending";
    verifiedCell.appendChild(verified);
    row.appendChild(verifiedCell);

    const planCell = document.createElement("td");
    planCell.className = "admin-plan-cell";
    const planBtn = document.createElement("button");
    planBtn.type = "button";
    planBtn.className = "admin-plan-badge";
    const planId = user.subscription?.tier || user.subscriptionTier || "free";
    planBtn.textContent = PLAN_LABELS[planId] || planId;
    planBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      openTierPicker(planBtn, userId, planId);
    });
    planCell.appendChild(planBtn);
    row.appendChild(planCell);

    const subCell = document.createElement("td");
    const status = document.createElement("span");
    const statusValue = String(user.subscription?.status || "none").toLowerCase();
    status.className = `admin-subscription-status admin-subscription-status--${statusValue.replace(/[^a-z0-9_]/g, "")}`;
    status.textContent = statusValue.replace(/_/g, " ");
    subCell.appendChild(status);
    row.appendChild(subCell);

    const billingCell = document.createElement("td");
    billingCell.className = "admin-billing-text";
    const parts = [];
    if (user.subscription?.currentPeriodEnd) {
      parts.push(`Until ${formatDate(user.subscription.currentPeriodEnd)}`);
    }
    if (user.subscription?.cancelAtPeriodEnd) parts.push("Cancels at period end");
    billingCell.textContent = parts.join(" · ") || "—";
    row.appendChild(billingCell);

    const creditsCell = document.createElement("td");
    const creditsBtn = document.createElement("button");
    creditsBtn.type = "button";
    creditsBtn.className = "admin-credits-badge";
    creditsBtn.textContent = formatNumber(user.credits);
    creditsBtn.title = "Modify credits";
    creditsBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      openAddCreditsDialog(userId);
    });
    creditsCell.appendChild(creditsBtn);
    row.appendChild(creditsCell);

    const purchasedCell = document.createElement("td");
    purchasedCell.textContent = formatNumber(user.creditsPurchased);
    row.appendChild(purchasedCell);

    const usedCell = document.createElement("td");
    usedCell.textContent = formatNumber(user.creditsUsed);
    row.appendChild(usedCell);

    const expiredCell = document.createElement("td");
    expiredCell.textContent = formatNumber(user.creditsExpired);
    row.appendChild(expiredCell);

    const expiringCell = document.createElement("td");
    expiringCell.textContent = formatNumber(user.creditsExpiring);
    row.appendChild(expiringCell);

    const nextExpiryCell = document.createElement("td");
    nextExpiryCell.className = "admin-billing-text admin-cell-nowrap";
    nextExpiryCell.textContent = user.nextExpiration
      ? formatDateTime(user.nextExpiration)
      : "—";
    row.appendChild(nextExpiryCell);

    const playbooksCell = document.createElement("td");
    playbooksCell.textContent = formatNumber(user.sessions ?? user.playbooks);
    row.appendChild(playbooksCell);

    const lastActiveCell = document.createElement("td");
    lastActiveCell.className = "admin-billing-text admin-cell-nowrap";
    lastActiveCell.textContent = user.lastActiveAt
      ? formatDateTime(user.lastActiveAt)
      : "Never";
    row.appendChild(lastActiveCell);

    const actionsCell = document.createElement("td");
    actionsCell.className = "admin-user-actions-cell";
    const kebab = document.createElement("button");
    kebab.type = "button";
    kebab.className = "admin-kebab-button";
    kebab.textContent = "\u22EE";
    kebab.title = "Actions";
    kebab.addEventListener("click", (event) => {
      event.stopPropagation();
      openKebabMenu(kebab, userId, user);
    });
    actionsCell.appendChild(kebab);
    row.appendChild(actionsCell);

    elements.usersTableBody.appendChild(row);
  });
}

function renderSummary(totals) {
  if (!totals) return;
  if (elements.totalUsers) elements.totalUsers.textContent = formatNumber(totals.totalUsers);
  if (elements.proSubscribers) {
    elements.proSubscribers.textContent = formatNumber(totals.proSubscribers);
  }
  if (elements.freeUsers) elements.freeUsers.textContent = formatNumber(totals.freeUsers);
  if (elements.unverifiedUsers) {
    elements.unverifiedUsers.textContent = formatNumber(totals.unverifiedUsers);
  }
  if (elements.totalCredits) {
    elements.totalCredits.textContent = formatNumber(totals.totalCredits);
  }
  if (elements.totalCreditsPurchased) {
    elements.totalCreditsPurchased.textContent = formatNumber(
      totals.totalCreditsPurchased,
    );
  }
  if (elements.totalCreditsUsed) {
    elements.totalCreditsUsed.textContent = formatNumber(totals.totalCreditsUsed);
  }
  if (elements.totalCreditsExpired) {
    elements.totalCreditsExpired.textContent = formatNumber(
      totals.totalCreditsExpired,
    );
  }
  if (elements.totalCreditsExpiring) {
    elements.totalCreditsExpiring.textContent = formatNumber(
      totals.totalCreditsExpiring,
    );
  }
  if (elements.totalPlaybooks) {
    elements.totalPlaybooks.textContent = formatNumber(
      totals.totalSessions ?? totals.totalPlaybooks,
    );
  }
}

function renderPlans(plans) {
  if (!elements.plansGrid) return;
  elements.plansGrid.innerHTML = "";
  (plans || []).forEach((plan) => {
    const card = document.createElement("div");
    card.className = "admin-pricing-card";
    const title = document.createElement("h3");
    title.textContent = plan.name || plan.id;
    const price = document.createElement("div");
    price.className = "admin-pricing-price";
    price.textContent = plan.priceLabel || `£${plan.priceGbp ?? 0}`;
    const blurb = document.createElement("p");
    blurb.textContent = plan.blurb || "";
    const credits = document.createElement("p");
    credits.textContent = `${formatNumber(plan.monthlyCredits || 0)} seconds of call time / month`;
    card.append(title, price, blurb, credits);
    elements.plansGrid.appendChild(card);
  });
}

function renderRecentActivity() {
  if (!elements.recentActivityBody) return;
  const rows = state.recentActivity;
  const totalPages = Math.max(1, Math.ceil(rows.length / ACTIVITY_PAGE_SIZE));
  if (state.recentActivityPage > totalPages) state.recentActivityPage = totalPages;
  const start = (state.recentActivityPage - 1) * ACTIVITY_PAGE_SIZE;
  const pageRows = rows.slice(start, start + ACTIVITY_PAGE_SIZE);

  elements.recentActivityBody.innerHTML = "";
  if (elements.recentActivityPageLabel) {
    elements.recentActivityPageLabel.textContent = `Page ${state.recentActivityPage} of ${totalPages}`;
  }
  if (elements.recentActivityPrev) {
    elements.recentActivityPrev.disabled = state.recentActivityPage <= 1;
  }
  if (elements.recentActivityNext) {
    elements.recentActivityNext.disabled = state.recentActivityPage >= totalPages;
  }

  if (!pageRows.length) {
    elements.recentActivityEmpty?.classList.remove("is-hidden");
    const empty = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 5;
    cell.className = "admin-table-empty";
    cell.textContent = "No recent activity.";
    empty.appendChild(cell);
    elements.recentActivityBody.appendChild(empty);
    return;
  }
  elements.recentActivityEmpty?.classList.add("is-hidden");

  pageRows.forEach((item) => {
    const row = document.createElement("tr");
    const time = document.createElement("td");
    time.className = "admin-cell-nowrap";
    time.textContent = formatDateTime(item.createdAt) || "—";
    const user = document.createElement("td");
    user.className = "admin-activity-user";
    const strong = document.createElement("strong");
    strong.textContent = item.user?.name || item.user?.email || "—";
    const email = document.createElement("span");
    email.textContent = item.user?.email || "";
    user.append(strong, email);
    const event = document.createElement("td");
    event.textContent = ACTIVITY_EVENT_LABELS[item.eventType] || item.eventType;
    const source = document.createElement("td");
    source.textContent = ACTIVITY_SOURCE_LABELS[item.source] || item.source || "—";
    const details = document.createElement("td");
    details.className = "admin-activity-details admin-billing-text";
    const meta = item.metadata || {};
    const bits = [];
    if (meta.creditsAdded) bits.push(`${formatNumber(meta.creditsAdded)} credits added`);
    if (meta.creditsRemoved) bits.push(`${formatNumber(meta.creditsRemoved)} credits removed`);
    if (meta.previousBalance != null && meta.updatedBalance != null) {
      bits.push(
        `${formatNumber(meta.previousBalance)} → ${formatNumber(meta.updatedBalance)}`,
      );
    }
    if (meta.credits) bits.push(`${formatNumber(meta.credits)} credits`);
    if (meta.expiresAt) bits.push(`expires ${formatDateTime(meta.expiresAt)}`);
    if (meta.purchaseMethod) bits.push(meta.purchaseMethod);
    if (meta.subject) bits.push(meta.subject);
    if (meta.newTier) bits.push(`${meta.previousTier || "?"} → ${meta.newTier}`);
    if (meta.sent != null) bits.push(`${meta.sent} sent, ${meta.failed || 0} failed`);
    details.textContent = bits.join(" · ") || "—";
    row.append(time, user, event, source, details);
    elements.recentActivityBody.appendChild(row);
  });
}

function startOfDayUTC(date) {
  const next = new Date(date);
  next.setUTCHours(0, 0, 0, 0);
  return next;
}

function shiftModelUsageAnchor(range, anchorDate, direction) {
  const anchor = startOfDayUTC(anchorDate);
  const delta = direction === "next" ? 1 : -1;
  if (range === "day") {
    anchor.setUTCDate(anchor.getUTCDate() + delta);
    return anchor;
  }
  if (range === "week") {
    anchor.setUTCDate(anchor.getUTCDate() + delta * 7);
    return anchor;
  }
  anchor.setUTCMonth(anchor.getUTCMonth() + delta);
  return anchor;
}

function destroyModelUsageChart() {
  if (state.modelUsageChartInstance) {
    state.modelUsageChartInstance.destroy();
    state.modelUsageChartInstance = null;
  }
}

function chartTickColor() {
  return getComputedStyle(document.documentElement).getPropertyValue("--muted").trim() ||
    "#9aa3b5";
}

function renderModelUsageChart(data) {
  const ChartLib = window.Chart;
  if (!elements.modelUsageChart || typeof ChartLib === "undefined") return;
  destroyModelUsageChart();
  const models = Array.isArray(data?.models) ? data.models : [];
  const series = Array.isArray(data?.series) ? data.series : [];
  if (!models.length || !series.length) return;
  const tick = chartTickColor();
  state.modelUsageChartInstance = new ChartLib(elements.modelUsageChart, {
    type: state.modelUsageChartType,
    data: {
      labels: series.map((point) => point.label),
      datasets: models.map((modelEntry, index) => {
        const color = CHART_COLORS[index % CHART_COLORS.length];
        return {
          label: `${modelEntry.model} (${modelEntry.provider})`,
          data: series.map((point) => point.totals[modelEntry.key] || 0),
          backgroundColor: state.modelUsageChartType === "bar" ? color : "transparent",
          borderColor: color,
          borderWidth: state.modelUsageChartType === "line" ? 2 : 1,
          tension: 0.25,
          fill: false,
        };
      }),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: "bottom", labels: { color: tick } },
        tooltip: {
          callbacks: {
            label(context) {
              return `${context.dataset.label}: ${formatNumber(context.parsed.y || 0)} credits`;
            },
          },
        },
      },
      scales: {
        x: {
          stacked: state.modelUsageChartType === "bar",
          ticks: { color: tick },
          grid: { color: "rgba(154,163,181,0.15)" },
        },
        y: {
          stacked: state.modelUsageChartType === "bar",
          beginAtZero: true,
          ticks: { color: tick, callback: (value) => formatNumber(value) },
          grid: { color: "rgba(154,163,181,0.15)" },
        },
      },
    },
  });
}

function renderModelUsageAnalytics(data) {
  state.modelUsageData = data;
  if (elements.modelUsagePeriodLabel) {
    elements.modelUsagePeriodLabel.textContent = data?.periodLabel || "—";
  }
  if (elements.modelUsageSummary) {
    elements.modelUsageSummary.innerHTML = "";
    const cards = [
      ["Selected period", `${formatNumber(data?.periodTotalCredits || 0)} credits`],
      ["All time", `${formatNumber(data?.allTimeTotalCredits || 0)} credits`],
      ["Calls this period", formatNumber(data?.periodTotalCalls || 0)],
    ];
    cards.forEach(([label, value]) => {
      const card = document.createElement("div");
      card.className = "admin-model-usage-summary-card";
      card.innerHTML = `<span class="admin-model-usage-summary-label"></span><span class="admin-model-usage-summary-value"></span>`;
      card.querySelector(".admin-model-usage-summary-label").textContent = label;
      card.querySelector(".admin-model-usage-summary-value").textContent = value;
      elements.modelUsageSummary.appendChild(card);
    });
  }
  if (elements.modelUsageStats) {
    elements.modelUsageStats.innerHTML = "";
    const periodRows = Array.isArray(data?.periodByModel) ? data.periodByModel : [];
    const allTimeRows = Array.isArray(data?.allTimeByModel) ? data.allTimeByModel : [];
    if (!periodRows.length && !allTimeRows.length) {
      if (elements.modelUsageStatus) {
        elements.modelUsageStatus.textContent = "No model usage recorded yet.";
      }
      destroyModelUsageChart();
      return;
    }
    if (elements.modelUsageStatus) {
      elements.modelUsageStatus.textContent =
        "Credit usage by model (admin accounts excluded)";
    }
    const allTimeMap = new Map(
      allTimeRows.map((row) => [`${row.provider}::${row.model}`, row.credits]),
    );
    const keys = new Set([
      ...periodRows.map((row) => `${row.provider}::${row.model}`),
      ...allTimeRows.map((row) => `${row.provider}::${row.model}`),
    ]);
    Array.from(keys)
      .map((key) => {
        const [provider, model] = [key.slice(0, key.indexOf("::")), key.slice(key.indexOf("::") + 2)];
        const period = periodRows.find(
          (row) => row.provider === provider && row.model === model,
        );
        return {
          provider,
          model,
          periodCredits: period?.credits || 0,
          allTimeCredits: allTimeMap.get(key) || 0,
        };
      })
      .sort((a, b) => b.allTimeCredits - a.allTimeCredits)
      .forEach((entry) => {
        const row = document.createElement("div");
        row.className = "admin-usage-stat";
        const label = document.createElement("span");
        label.className = "admin-usage-stat-label";
        label.textContent = `${entry.model} (${entry.provider})`;
        const value = document.createElement("span");
        value.className = "admin-usage-stat-value";
        value.textContent = `${formatNumber(entry.periodCredits)} / ${formatNumber(entry.allTimeCredits)} credits`;
        row.append(label, value);
        elements.modelUsageStats.appendChild(row);
      });
  }
  renderModelUsageChart(data);
}

async function loadModelUsageAnalytics() {
  if (state.modelUsageLoading) return;
  state.modelUsageLoading = true;
  if (elements.modelUsageStatus) elements.modelUsageStatus.textContent = "Loading model usage…";
  try {
    const params = new URLSearchParams({
      range: state.modelUsageRange,
      anchor: startOfDayUTC(state.modelUsageAnchor).toISOString(),
    });
    const response = await authFetch(`/api/admin/model-usage/analytics?${params}`);
    throwIfAuthError(response);
    if (!response.ok) throw new Error("Failed to load model usage analytics.");
    renderModelUsageAnalytics(await response.json());
  } catch (error) {
    handleAuthRedirect(error);
    if (elements.modelUsageStatus) {
      elements.modelUsageStatus.textContent = "Unable to load model usage analytics.";
    }
    destroyModelUsageChart();
  } finally {
    state.modelUsageLoading = false;
  }
}

function handleAuthRedirect(error) {
  if (error?.status === 401) {
    window.location.href = "/index.html";
    return true;
  }
  if (error?.status === 403) {
    window.location.href = "/app.html";
    return true;
  }
  return false;
}

function getUserById(userId) {
  return state.usersById.get(String(userId)) || null;
}

function renderAdminCreditLots(details) {
  const root = elements.creditLots;
  if (!root) return;
  const lots = details?.lots || [];
  if (!lots.length) {
    root.innerHTML = `<p class="admin-modal-hint">No credit lots yet.</p>`;
    return;
  }
  const totals = details.totals || {};
  root.innerHTML = `
    <div class="admin-credit-lot-summary">
      <span>Used ${formatNumber(totals.used)}</span>
      <span>Expiring ${formatNumber(totals.goingToExpire)}</span>
      <span>Expired ${formatNumber(totals.expired)}</span>
    </div>
    <div class="admin-users-table-wrapper">
      <table class="admin-users-table admin-credit-lot-table">
        <thead>
          <tr>
            <th>Purchased</th>
            <th>Expires</th>
            <th>Added</th>
            <th>Used</th>
            <th>Going to expire</th>
            <th>Expired</th>
          </tr>
        </thead>
        <tbody>
          ${lots
            .map(
              (lot) => `<tr>
                <td>${formatDateTime(lot.purchasedAt) || "—"}</td>
                <td>${formatDateTime(lot.expiresAt) || "—"}</td>
                <td>${formatNumber(lot.purchased)}</td>
                <td>${formatNumber(lot.used)}</td>
                <td>${formatNumber(lot.goingToExpire)}</td>
                <td>${formatNumber(lot.expired)}</td>
              </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>`;
}

function openAddCreditsDialog(userId) {
  const user = getUserById(userId);
  if (!user) return;
  state.selectedUserId = userId;
  state.addCreditsMessageDirty = false;
  elements.addCreditsForm?.reset();
  setModalError(elements.addCreditsError, "");
  if (elements.addCreditsTitle) {
    elements.addCreditsTitle.textContent = `Modify credits — ${user.name || user.email}`;
  }
  if (elements.addCreditsCurrent) {
    elements.addCreditsCurrent.textContent = `Current balance: ${formatNumber(user.credits)}`;
  }
  if (elements.addCreditsAmount) {
    elements.addCreditsAmount.value = String(Math.max(0, Math.round(Number(user.credits) || 0)));
  }
  if (elements.creditLots) {
    elements.creditLots.innerHTML = `<p class="admin-modal-hint">Loading usage…</p>`;
  }
  openModal(elements.addCreditsModal);
  elements.addCreditsAmount?.focus();
  elements.addCreditsAmount?.select();
  authFetch(`/api/admin/users/${encodeURIComponent(userId)}/credits`)
    .then(async (response) => {
      throwIfAuthError(response);
      if (!response.ok) throw new Error("Failed to load credit lots.");
      renderAdminCreditLots(await response.json());
    })
    .catch((error) => {
      if (handleAuthRedirect(error)) return;
      if (elements.creditLots) {
        elements.creditLots.innerHTML = `<p class="admin-modal-hint">Could not load credit lots.</p>`;
      }
    });
}

function openChangePlanDialog(userId) {
  const user = getUserById(userId);
  if (!user) return;
  state.selectedUserId = userId;
  setModalError(elements.changePlanError, "");
  const planId = user.subscription?.tier || user.subscriptionTier || "free";
  if (elements.changePlanTitle) {
    elements.changePlanTitle.textContent = `Change plan — ${user.name || user.email}`;
  }
  if (elements.changePlanDescription) {
    elements.changePlanDescription.textContent = `Current plan: ${PLAN_LABELS[planId] || planId}. This updates the account in Call & Translate; it does not change Stripe billing by itself.`;
  }
  if (elements.changePlanSelect) elements.changePlanSelect.value = PLAN_ORDER.includes(planId) ? planId : "free";
  openModal(elements.changePlanModal);
  elements.changePlanSelect?.focus();
}

function openMessageUserDialog(userId) {
  const user = getUserById(userId);
  if (!user) return;
  state.selectedUserId = userId;
  elements.messageUserForm?.reset();
  setModalError(elements.messageUserError, "");
  if (elements.messageUserTitle) {
    elements.messageUserTitle.textContent = `Message ${user.name || user.email}`;
  }
  if (elements.messageBody) elements.messageBody.value = `Hi ${user.name || "there"},\n\n`;
  openModal(elements.messageUserModal);
  elements.messageBody?.focus();
}

function openDeleteUserDialog(userId) {
  const user = getUserById(userId);
  if (!user) return;
  state.selectedUserId = userId;
  state.selectedUserEmail = user.email || "";
  state.deleteConfirmationValue = DELETE_CONFIRMATION_WORD;
  elements.deleteUserForm?.reset();
  setModalError(elements.deleteUserError, "");
  if (elements.deleteUserTitle) {
    elements.deleteUserTitle.textContent = `Delete ${user.name || user.email}`;
  }
  if (elements.deleteUserDescription) {
    elements.deleteUserDescription.textContent = `This permanently deletes ${user.email}. Type DELETE to confirm.`;
  }
  if (elements.deleteUserConfirm) {
    elements.deleteUserConfirm.value = "";
    elements.deleteUserConfirm.placeholder = DELETE_CONFIRMATION_WORD;
  }
  openModal(elements.deleteUserModal);
  elements.deleteUserConfirm?.focus();
}

function openMessageAllDialog() {
  elements.messageAllForm?.reset();
  setModalError(elements.messageAllError, "");
  setMessageAllProgress("");
  if (elements.messageAllAiModel) elements.messageAllAiModel.value = "grok-4.6";
  openModal(elements.messageAllModal);
  elements.messageAllBody?.focus();
}

function setMessageAllProgress(text) {
  if (!elements.messageAllProgress) return;
  elements.messageAllProgress.textContent = text || "";
  elements.messageAllProgress.classList.toggle("is-hidden", !text);
}

async function handleAddCreditsSubmit(event) {
  event.preventDefault();
  const credits = Number(elements.addCreditsAmount?.value);
  if (!Number.isInteger(credits) || credits < 0) {
    setModalError(elements.addCreditsError, "Enter a whole number of credits (0 or more).");
    return;
  }
  try {
    const result = await postJson(
      `/api/admin/users/${encodeURIComponent(state.selectedUserId)}/credits`,
      {
        credits,
        mode: "set",
        message: elements.addCreditsMessage?.value || "",
      },
    );
    closeModal();
    const previous = Number(result?.previousBalance);
    const updated = Number(result?.updatedBalance);
    if (Number.isFinite(previous) && Number.isFinite(updated) && previous !== updated) {
      updateStatus(
        `Credits updated: ${formatNumber(previous)} → ${formatNumber(updated)}.`,
      );
    } else {
      updateStatus("Credit balance unchanged.");
    }
    await loadDashboard();
  } catch (error) {
    if (handleAuthRedirect(error)) return;
    setModalError(elements.addCreditsError, error.message);
  }
}

async function handleChangePlanSubmit(event) {
  event.preventDefault();
  const tier = String(elements.changePlanSelect?.value || "").toLowerCase();
  if (!PLAN_ORDER.includes(tier)) {
    setModalError(elements.changePlanError, "Choose a plan.");
    return;
  }
  try {
    await updateUserPlan(state.selectedUserId, tier);
    closeModal();
    updateStatus(`Plan set to ${PLAN_LABELS[tier] || tier}.`);
    await loadDashboard();
  } catch (error) {
    if (handleAuthRedirect(error)) return;
    setModalError(elements.changePlanError, error.message);
  }
}

async function handleMessageUserSubmit(event) {
  event.preventDefault();
  const message = elements.messageBody?.value.trim();
  if (!message) {
    setModalError(elements.messageUserError, "Please enter a message.");
    return;
  }
  try {
    await postJson(`/api/admin/users/${encodeURIComponent(state.selectedUserId)}/message`, {
      subject: elements.messageSubject?.value.trim() || "",
      message,
      copyToAdmin: Boolean(elements.messageCopy?.checked),
    });
    closeModal();
    updateStatus("Message sent.");
    await loadDashboard();
  } catch (error) {
    if (handleAuthRedirect(error)) return;
    setModalError(elements.messageUserError, error.message);
  }
}

async function handleDeleteUserSubmit(event) {
  event.preventDefault();
  const typed = elements.deleteUserConfirm?.value.trim();
  if (typed !== DELETE_CONFIRMATION_WORD) {
    setModalError(elements.deleteUserError, "Type DELETE to confirm.");
    return;
  }
  try {
    const response = await authFetch(
      `/api/admin/users/${encodeURIComponent(state.selectedUserId)}`,
      { method: "DELETE" },
    );
    throwIfAuthError(response);
    if (!response.ok) {
      throw new Error(await parseErrorMessage(response, "Unable to delete user."));
    }
    closeModal();
    updateStatus("User deleted.");
    await loadDashboard();
  } catch (error) {
    if (handleAuthRedirect(error)) return;
    setModalError(elements.deleteUserError, error.message);
  }
}

async function handleMessageAllAiGenerate() {
  const prompt = elements.messageAllAiPrompt?.value.trim();
  if (!prompt) {
    setModalError(elements.messageAllError, "Enter instructions for the AI draft.");
    return;
  }
  setModalError(elements.messageAllError, "");
  setMessageAllProgress("Generating draft…");
  elements.messageAllAiGenerate.disabled = true;
  try {
    const draft = await postJson("/api/admin/message-all/draft", {
      prompt,
      model: elements.messageAllAiModel?.value || "grok-4.6",
    });
    if (draft.subject && elements.messageAllSubject) {
      elements.messageAllSubject.value = draft.subject;
    }
    if (draft.message && elements.messageAllBody) {
      elements.messageAllBody.value = draft.message;
    }
    setMessageAllProgress("Draft inserted. Review before sending.");
  } catch (error) {
    if (handleAuthRedirect(error)) return;
    setModalError(elements.messageAllError, error.message);
    setMessageAllProgress("");
  } finally {
    elements.messageAllAiGenerate.disabled = false;
  }
}

async function handleMessageAllSubmit(event) {
  event.preventDefault();
  const subject = elements.messageAllSubject?.value.trim();
  const message = elements.messageAllBody?.value.trim();
  if (!subject) {
    setModalError(elements.messageAllError, "Please enter a subject.");
    return;
  }
  if (!message) {
    setModalError(elements.messageAllError, "Please enter a message.");
    return;
  }
  setModalError(elements.messageAllError, "");
  setMessageAllProgress("Sending…");
  try {
    const result = await postJson("/api/admin/message-all/send", { subject, message });
    closeModal();
    updateStatus(
      `Sent to ${result.sent} of ${result.total} users${result.failed ? ` (${result.failed} failed)` : ""}.`,
    );
    await loadDashboard();
  } catch (error) {
    if (handleAuthRedirect(error)) return;
    setModalError(elements.messageAllError, error.message);
    setMessageAllProgress("");
  }
}

async function loadDashboard() {
  if (elements.refreshButton) elements.refreshButton.disabled = true;
  updateStatus("Loading dashboard…");
  try {
    const response = await authFetch("/api/admin/dashboard");
    throwIfAuthError(response);
    if (!response.ok) throw new Error("Failed to load admin dashboard data.");
    const data = await response.json();
    state.dashboardUsers = Array.isArray(data.users) ? data.users : [];
    state.recentActivity = Array.isArray(data.recentSubscriptionActivity)
      ? data.recentSubscriptionActivity
      : [];
    state.recentActivityPage = 1;
    updateUserSortIndicators();
    renderUsers(getVisibleUsers());
    renderSummary(data.totals);
    renderPlans(data.plans);
    renderRecentActivity();
    await loadModelUsageAnalytics();
    updateStatus(state.dashboardUsers.length ? "" : "No users found yet.");
  } catch (error) {
    if (handleAuthRedirect(error)) return;
    updateStatus("Unable to load admin dashboard data right now.", "error");
  } finally {
    if (elements.refreshButton) elements.refreshButton.disabled = false;
  }
}

function bindEvents() {
  elements.backButton?.addEventListener("click", () => {
    window.location.href = "/app.html";
  });
  elements.refreshButton?.addEventListener("click", () => loadDashboard());
  elements.userSortButtons.forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.sortKey) setUserSort(button.dataset.sortKey);
    });
  });
  const handleSearch = () => {
    state.userSearchQuery = elements.usersSearch.value || "";
    renderUsers(getVisibleUsers());
  };
  elements.usersSearch?.addEventListener("input", handleSearch);
  elements.usersSearch?.addEventListener("search", handleSearch);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.activeModal) closeModal();
  });
  document.querySelectorAll("[data-admin-modal-close]").forEach((button) => {
    button.addEventListener("click", closeModal);
  });
  elements.modalBackdrop?.addEventListener("click", closeModal);
  elements.addCreditsCancel?.addEventListener("click", closeModal);
  elements.changePlanCancel?.addEventListener("click", closeModal);
  elements.messageUserCancel?.addEventListener("click", closeModal);
  elements.deleteUserCancel?.addEventListener("click", closeModal);
  elements.messageAllCancel?.addEventListener("click", closeModal);
  elements.messageAllButton?.addEventListener("click", openMessageAllDialog);
  elements.messageAllAiGenerate?.addEventListener("click", handleMessageAllAiGenerate);
  elements.messageAllForm?.addEventListener("submit", handleMessageAllSubmit);
  elements.addCreditsForm?.addEventListener("submit", handleAddCreditsSubmit);
  elements.changePlanForm?.addEventListener("submit", handleChangePlanSubmit);
  elements.messageUserForm?.addEventListener("submit", handleMessageUserSubmit);
  elements.deleteUserForm?.addEventListener("submit", handleDeleteUserSubmit);

  elements.modelUsageRangeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.modelUsageRange = button.dataset.range;
      elements.modelUsageRangeButtons.forEach((btn) => {
        btn.classList.toggle("is-active", btn === button);
      });
      loadModelUsageAnalytics();
    });
  });
  elements.modelUsageChartTypeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.modelUsageChartType = button.dataset.chartType;
      elements.modelUsageChartTypeButtons.forEach((btn) => {
        btn.classList.toggle("is-active", btn === button);
      });
      renderModelUsageChart(state.modelUsageData);
    });
  });
  elements.modelUsagePrev?.addEventListener("click", () => {
    state.modelUsageAnchor = shiftModelUsageAnchor(
      state.modelUsageRange,
      state.modelUsageAnchor,
      "prev",
    );
    loadModelUsageAnalytics();
  });
  elements.modelUsageNext?.addEventListener("click", () => {
    state.modelUsageAnchor = shiftModelUsageAnchor(
      state.modelUsageRange,
      state.modelUsageAnchor,
      "next",
    );
    loadModelUsageAnalytics();
  });
  elements.recentActivityPrev?.addEventListener("click", () => {
    state.recentActivityPage = Math.max(1, state.recentActivityPage - 1);
    renderRecentActivity();
  });
  elements.recentActivityNext?.addEventListener("click", () => {
    state.recentActivityPage += 1;
    renderRecentActivity();
  });
}

bindEvents();
loadDashboard();
