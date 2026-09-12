import {
  CREDITS_PER_CALL_SECOND,
  CREDIT_MINUTE_USD_VALUE,
  MONTHLY_SUBSCRIPTION_CREDITS,
  CREDIT_TOPUP_CREDITS,
  creditsFromCallSeconds,
  creditsFromUsdCost,
  estimatedCreditsForCall,
  formatCallTime,
  publicCreditCalculator,
} from "../utils/creditCalculator.js";
import {
  calculateXaiSttCost,
  calculateXaiTokenCost,
} from "../utils/xaiUsageMetrics.js";

describe("credit calculator", () => {
  test("1 credit is 1 second of call time", () => {
    expect(CREDITS_PER_CALL_SECOND).toBe(1);
    expect(MONTHLY_SUBSCRIPTION_CREDITS).toBe(3600);
    expect(CREDIT_TOPUP_CREDITS).toBe(3600);
    expect(creditsFromCallSeconds(0)).toBe(0);
    expect(creditsFromCallSeconds(1)).toBe(1);
    expect(creditsFromCallSeconds(60.2)).toBe(61);
    expect(estimatedCreditsForCall("voice-call", { durationSec: 120 })).toBe(120);
  });

  test("formats remaining time for the UI", () => {
    expect(formatCallTime(0)).toBe("0s");
    expect(formatCallTime(45)).toBe("45s");
    expect(formatCallTime(90)).toBe("1m 30s");
    expect(formatCallTime(3600)).toBe("1h 00m");
  });

  test("public calculator talks about call time, not tokens or dollars", () => {
    const rates = publicCreditCalculator();
    expect(rates.topUp.priceGbp).toBe(12);
    expect(rates.topUp.credits).toBe(3600);
    expect(rates).not.toHaveProperty("usdValue");
    expect(JSON.stringify(rates)).not.toMatch(/\$/);
    expect(rates.creditsPerSecond).toBe(1);
  });

  test("xAI dollar costs convert to call seconds at $0.0833 per minute", () => {
    expect(CREDIT_MINUTE_USD_VALUE).toBe(0.0833);
    expect(creditsFromUsdCost(0)).toBe(0);
    expect(creditsFromUsdCost(0.0833)).toBe(60);
    expect(creditsFromUsdCost(0.0001)).toBe(1);
    const grok = calculateXaiTokenCost({
      model: "grok-4.6",
      inputTokens: 1000,
      outputTokens: 500,
      reasoningTokens: 200,
    });
    expect(grok.totalCost).toBeCloseTo(0.0062, 6);
    expect(creditsFromUsdCost(grok.totalCost)).toBe(5);
    expect(calculateXaiSttCost({ durationSec: 3600, streaming: false })).toBeCloseTo(
      0.1,
      8,
    );
    expect(calculateXaiSttCost({ durationSec: 3600, streaming: true })).toBeCloseTo(
      0.2,
      8,
    );
    expect(
      creditsFromUsdCost(calculateXaiSttCost({ durationSec: 60, streaming: false })),
    ).toBe(2);
  });

  test("client explainer does not mention tokens", async () => {
    const { creditExplainerHtml, creditCalculatorHtml } = await import(
      "../public/js/creditCalculator.js"
    );
    const html = `${creditExplainerHtml()}${creditCalculatorHtml()}`;
    expect(html.toLowerCase()).not.toMatch(/token/);
    expect(html).toMatch(/call time/i);
    expect(html).toMatch(/Dictate and fill/i);
  });
});
