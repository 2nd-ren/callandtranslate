import { jest } from "@jest/globals";
import {
  buildEmailCardHtml,
  PRODUCT_NAME,
  SUPPORT_EMAIL,
} from "../utils/emailHtml.js";
import {
  WELCOME_SUBJECT,
  buildSubscriptionWelcomeEmail,
  sendSubscriptionWelcomeIfNeeded,
} from "../utils/subscriptionWelcomeEmail.js";
import {
  CREDIT_PURCHASE_SUBJECT,
  buildCreditPurchaseEmail,
} from "../utils/creditPurchaseEmail.js";
import {
  CANCEL_ENDED_SUBJECT,
  CANCEL_REQUESTED_SUBJECT,
  buildSubscriptionCancelEmail,
  sendCancellationFeedbackIfNeeded,
  clearCancellationFeedbackFlag,
} from "../utils/subscriptionCancelEmail.js";

describe("branded emails", () => {
  test("card template includes Call & Translate branding", () => {
    const html = buildEmailCardHtml({
      title: "Hello",
      lead: "This is a test message.",
      ctaUrl: "https://callandtranslate.com/app.html",
      ctaLabel: "Open Call & Translate",
    });
    expect(html).toMatch(/Call <span style="color:#ff7a18;">&amp;<\/span> Translate/);
    expect(html).toMatch(/#ff7a18/);
    expect(html).toMatch(/#07051a/);
    expect(html).toContain("Open Call &amp; Translate");
    expect(html).toContain(SUPPORT_EMAIL);
    expect(html).toContain("Call &amp; Translate");
  });

  test("welcome email thanks the subscriber and invites a reply", () => {
    const email = buildSubscriptionWelcomeEmail({
      userName: "Ada",
      planName: "Pro",
      supportEmail: "info@callandtranslate.com",
      appUrl: "https://callandtranslate.com",
    });
    expect(email.subject).toBe(WELCOME_SUBJECT);
    expect(email.textBody).toMatch(/Hi Ada/);
    expect(email.textBody).toMatch(/Thank you for subscribing to Call & Translate/);
    expect(email.textBody).toMatch(/struggle with it or cancel/);
    expect(email.textBody).toMatch(/small, responsive team/);
    expect(email.htmlBody).toMatch(/Thanks for subscribing/);
    expect(email.htmlBody).toMatch(/1 hour added each month/);
    expect(email.htmlBody).toMatch(/30 days after they are added/);
    expect(email.htmlBody).toMatch(/https:\/\/callandtranslate\.com\/app\.html/);
    expect(email.htmlBody).toMatch(/Call <span style="color:#ff7a18;">&amp;<\/span> Translate/);
  });

  test("credit purchase email includes amount, purchase date, and expiry", () => {
    const purchasedAt = new Date("2026-09-09T12:00:00.000Z");
    const expiresAt = new Date("2026-10-09T12:00:00.000Z");
    const email = buildCreditPurchaseEmail({
      userName: "Ada",
      credits: 3600,
      packs: 1,
      amountPence: 1200,
      currency: "gbp",
      purchasedAt,
      expiresAt,
      newBalance: 3600,
      appUrl: "https://callandtranslate.com",
    });
    expect(email.subject).toBe(CREDIT_PURCHASE_SUBJECT);
    expect(email.textBody).toMatch(/Hi Ada/);
    expect(email.textBody).toMatch(/3,600/);
    expect(email.textBody).toMatch(/£12\.00/);
    expect(email.textBody).toMatch(/Expires:/);
    expect(email.htmlBody).toMatch(/Purchase date/);
    expect(email.htmlBody).toMatch(/Expires/);
    expect(email.htmlBody).toMatch(/New balance/);
    expect(email.htmlBody).toMatch(/3,600/);
    expect(email.htmlBody).toMatch(/https:\/\/callandtranslate\.com\/app\.html/);
  });

  test("cancel requested email asks what was wrong", () => {
    const email = buildSubscriptionCancelEmail({
      userName: "Ada",
      planName: "Pro",
      periodEnd: "2026-09-30T00:00:00.000Z",
      stage: "requested",
      appUrl: "https://callandtranslate.com",
    });
    expect(email.subject).toBe(CANCEL_REQUESTED_SUBJECT);
    expect(email.textBody).toMatch(/We've received your cancellation/);
    expect(email.textBody).toMatch(/lose you over something we can change/);
    expect(email.htmlBody).toMatch(/Sorry to see you go/);
    expect(email.htmlBody).toMatch(/Keep my subscription/);
    expect(email.htmlBody).toMatch(/https:\/\/callandtranslate\.com\/app\.html/);
  });

  test("cancel ended email offers resubscribe", () => {
    const email = buildSubscriptionCancelEmail({
      userName: "Ada",
      planName: "Pro",
      stage: "ended",
      appUrl: "https://callandtranslate.com",
    });
    expect(email.subject).toBe(CANCEL_ENDED_SUBJECT);
    expect(email.textBody).toMatch(/has ended/);
    expect(email.textBody).toMatch(/free plan/);
    expect(email.htmlBody).toMatch(/Resubscribe/);
    expect(email.htmlBody).toMatch(/https:\/\/callandtranslate\.com\/pricing\.html/);
  });

  test("welcome send claims the user flag once", async () => {
    const user = {
      _id: "user_1",
      name: "Ada",
      email: "ada@example.com",
    };
    const UserModel = {
      findOneAndUpdate: jest.fn().mockResolvedValue({ _id: "user_1" }),
      updateOne: jest.fn(),
    };
    const mailer = jest.fn().mockResolvedValue({ success: true });
    const sentAt = new Date("2026-09-09T12:00:00.000Z");

    const result = await sendSubscriptionWelcomeIfNeeded({
      user,
      tier: "pro",
      mailer,
      UserModel,
      now: () => sentAt,
      appUrl: "https://callandtranslate.com",
    });

    expect(result).toEqual({ sent: true, reason: "sent" });
    expect(UserModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ _id: "user_1" }),
      { $set: { subscriptionWelcomeEmailSentAt: sentAt } },
      { new: false },
    );
    expect(mailer).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ada@example.com",
        subject: WELCOME_SUBJECT,
      }),
    );
  });

  test("welcome is not sent twice or for free accounts", async () => {
    const mailer = jest.fn();
    const UserModel = {
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn(),
    };
    await expect(
      sendSubscriptionWelcomeIfNeeded({
        user: { _id: "user_1", email: "a@example.com" },
        tier: "free",
        mailer,
        UserModel,
      }),
    ).resolves.toEqual({ sent: false, reason: "unpaid_tier" });
    await expect(
      sendSubscriptionWelcomeIfNeeded({
        user: {
          _id: "user_1",
          email: "a@example.com",
          subscriptionWelcomeEmailSentAt: new Date(),
        },
        tier: "pro",
        mailer,
        UserModel,
      }),
    ).resolves.toEqual({ sent: false, reason: "already_sent" });
    expect(mailer).not.toHaveBeenCalled();
  });

  test("cancel feedback send claims the user flag once", async () => {
    const user = {
      _id: "user_1",
      name: "Ada",
      email: "ada@example.com",
    };
    const UserModel = {
      findOneAndUpdate: jest.fn().mockResolvedValue({ _id: "user_1" }),
      updateOne: jest.fn(),
    };
    const mailer = jest.fn().mockResolvedValue({ success: true });
    const result = await sendCancellationFeedbackIfNeeded({
      user,
      tier: "pro",
      stage: "requested",
      mailer,
      UserModel,
    });
    expect(result.sent).toBe(true);
    expect(result.stage).toBe("requested");
    expect(mailer).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "ada@example.com",
        subject: CANCEL_REQUESTED_SUBJECT,
      }),
    );
  });

  test("clearCancellationFeedbackFlag unsets the send marker", async () => {
    const user = {
      _id: "user_1",
      subscriptionCancelFeedbackEmailSentAt: new Date(),
    };
    const UserModel = {
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    await clearCancellationFeedbackFlag(user, UserModel);
    expect(user.subscriptionCancelFeedbackEmailSentAt).toBeNull();
    expect(UserModel.updateOne).toHaveBeenCalledWith(
      { _id: "user_1" },
      { $unset: { subscriptionCancelFeedbackEmailSentAt: 1 } },
    );
  });
});
