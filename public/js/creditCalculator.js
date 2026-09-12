export const DEFAULT_CREDIT_RATES = {
  creditsPerSecond: 1,
  expiryDays: 30,
  monthlyCredits: 3600,
  freeMonthlyCredits: 0,
  topUp: {
    credits: 3600,
    priceGbp: 12,
    priceLabel: "£12",
    expiryDays: 30,
    maxPacks: 10,
  },
};

export function mergeCreditRates(rates) {
  const next = { ...DEFAULT_CREDIT_RATES, ...(rates || {}) };
  next.topUp = { ...DEFAULT_CREDIT_RATES.topUp, ...(rates?.topUp || {}) };
  return next;
}

export function formatCallTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, "0")}s`;
  return `${sec}s`;
}

export function formatCredits(value) {
  return formatCallTime(value);
}

export function creditsFromCallSeconds(seconds, rates = DEFAULT_CREDIT_RATES) {
  const r = mergeCreditRates(rates);
  const sec = Math.max(0, Number(seconds) || 0);
  if (sec <= 0) return 0;
  return Math.max(1, Math.ceil(sec * (r.creditsPerSecond || 1)));
}

export function creditExplainerHtml(rates = DEFAULT_CREDIT_RATES, { heading = true } = {}) {
  const r = mergeCreditRates(rates);
  return `
    <div class="credit-explainer">
      ${heading ? "<h4>How call time works</h4>" : ""}
      <p>
        Paid adds <strong>${formatCallTime(r.monthlyCredits)}</strong> each time
        your subscription is billed. Time expires <strong>${r.expiryDays} days</strong>
        after it is added.
      </p>
      <p>
        Connected call seconds are deducted as they are used. Live translation
        during a call is included in that call time.
      </p>
      <p>
        Dictate and fill uses extra call time for speech-to-text and Grok.
        The post-call report also uses a little call time.
      </p>
      <p>
        Extra hours cost ${r.topUp?.priceLabel || "£12"} for
        ${formatCallTime(r.topUp?.credits || r.monthlyCredits)} and expire
        ${r.expiryDays} days after purchase.
      </p>
    </div>`;
}

export function creditTopUpHtml(topUp, { id = "creditTopUpPacks" } = {}) {
  const pack = topUp || DEFAULT_CREDIT_RATES.topUp;
  const credits = formatCallTime(pack.credits || 3600);
  const price = pack.priceLabel || `£${pack.priceGbp || 12}`;
  const max = Number(pack.maxPacks) || 10;
  return `
    <div class="credit-topup">
      <h4>Buy an extra hour</h4>
      <p>
        ${credits} for ${price}. Expires ${pack.expiryDays || 30} days after purchase.
      </p>
      <div class="credit-topup-row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <label for="${id}">Hours</label>
        <input id="${id}" data-credit-packs type="number" min="1" max="${max}" value="1" step="1" />
        <button type="button" class="btn btn-primary" data-buy-credits>Buy extra time</button>
      </div>
    </div>`;
}

export function creditCalculatorHtml(prefix = "cc") {
  return `
    <div class="credit-calculator" data-credit-calculator="${prefix}">
      <h4>Call time calculator</h4>
      <p>Estimate how much of your hour a call will use.</p>
      <div class="field">
        <label for="${prefix}-minutes">Call length (minutes)</label>
        <input id="${prefix}-minutes" type="number" min="0" step="0.5" value="10" />
      </div>
      <p class="credit-calc-total">Estimated use: <strong data-cc-total>10m 00s</strong></p>
    </div>`;
}

export function mountCreditCalculator(root, rates = DEFAULT_CREDIT_RATES) {
  const wrap = root?.matches?.("[data-credit-calculator]")
    ? root
    : root?.querySelector?.("[data-credit-calculator]");
  if (!wrap) return;
  const r = mergeCreditRates(rates);
  const minutesEl = wrap.querySelector('input[id$="-minutes"]');
  const totalEl = wrap.querySelector("[data-cc-total]");

  function update() {
    const minutes = Math.max(0, Number(minutesEl?.value) || 0);
    const credits = creditsFromCallSeconds(minutes * 60, r);
    if (totalEl) totalEl.textContent = formatCallTime(credits);
  }

  minutesEl?.addEventListener("input", update);
  update();
}
