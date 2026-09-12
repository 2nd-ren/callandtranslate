import { escapeHtml, isHttpUrl } from "./urlCards.js";

let pendingClose = null;

function ensureRoots() {
  let dialogs = document.getElementById("dialogRoot");
  if (!dialogs) {
    dialogs = document.createElement("div");
    dialogs.id = "dialogRoot";
    document.body.appendChild(dialogs);
  }
  let toasts = document.getElementById("toastRoot");
  if (!toasts) {
    toasts = document.createElement("div");
    toasts.id = "toastRoot";
    toasts.className = "toast-stack";
    toasts.setAttribute("aria-live", "polite");
    document.body.appendChild(toasts);
  }
  return { dialogs, toasts };
}

function dismissDialog(result) {
  if (pendingClose) pendingClose(result);
}

export function toast(text, { variant = "info", duration = 2800 } = {}) {
  const message = String(text || "").trim();
  if (!message) return;
  const { toasts } = ensureRoots();
  const el = document.createElement("div");
  el.className = `toast${variant === "error" ? " error" : variant === "ok" ? " ok" : ""}`;
  el.textContent = message;
  toasts.appendChild(el);
  window.setTimeout(() => el.remove(), duration);
}

export function customDialog({
  title,
  html = "",
  cardClass = "",
  closeLabel = "Close",
  onReady,
} = {}) {
  return new Promise((resolve) => {
    const { dialogs } = ensureRoots();
    dismissDialog(null);
    const previous = document.activeElement;
    const wrap = document.createElement("div");
    wrap.className = "dialog";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-labelledby", "dialogTitle");
    wrap.innerHTML = `
      <div class="dialog-card ${cardClass}">
        <div class="dialog-head">
          <h3 id="dialogTitle">${escapeHtml(title || "")}</h3>
          <button type="button" class="dialog-close" data-cancel aria-label="${escapeHtml(closeLabel)}">&times;</button>
        </div>
        <div class="dialog-body" data-dialog-body>${html}</div>
        <div class="dialog-actions">
          <button type="button" class="btn btn-primary" data-ok>${escapeHtml(closeLabel)}</button>
        </div>
      </div>`;
    dialogs.innerHTML = "";
    dialogs.appendChild(wrap);

    const finish = (value) => {
      if (pendingClose !== finish) return;
      pendingClose = null;
      dialogs.innerHTML = "";
      document.removeEventListener("keydown", onKey);
      if (previous && typeof previous.focus === "function") {
        try {
          previous.focus();
        } catch {
          // ignore
        }
      }
      resolve(value);
    };
    pendingClose = finish;

    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(null);
      }
    };
    document.addEventListener("keydown", onKey);
    wrap.addEventListener("click", (event) => {
      if (event.target === wrap) finish(null);
    });
    wrap.querySelector("[data-cancel]").onclick = () => finish(null);
    wrap.querySelector("[data-ok]").onclick = () => finish(true);
    onReady?.({
      root: wrap,
      body: wrap.querySelector("[data-dialog-body]"),
      close: finish,
    });
    wrap.querySelector("[data-ok]")?.focus();
  });
}

export function confirmDialog({
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
} = {}) {
  return new Promise((resolve) => {
    const { dialogs } = ensureRoots();
    dismissDialog(false);
    const previous = document.activeElement;
    const wrap = document.createElement("div");
    wrap.className = "dialog";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-labelledby", "dialogTitle");
    wrap.innerHTML = `
      <div class="dialog-card">
        <h3 id="dialogTitle">${escapeHtml(title || "Please confirm")}</h3>
        <p>${escapeHtml(body || "")}</p>
        <div class="dialog-actions">
          <button type="button" class="btn" data-cancel>${escapeHtml(cancelLabel)}</button>
          <button type="button" class="btn ${danger ? "btn-danger" : "btn-primary"}" data-ok>${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    dialogs.innerHTML = "";
    dialogs.appendChild(wrap);

    const finish = (value) => {
      if (pendingClose !== finish) return;
      pendingClose = null;
      dialogs.innerHTML = "";
      document.removeEventListener("keydown", onKey);
      if (previous && typeof previous.focus === "function") {
        try {
          previous.focus();
        } catch {
          // ignore
        }
      }
      resolve(value);
    };
    pendingClose = finish;

    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false);
      }
    };
    document.addEventListener("keydown", onKey);
    wrap.addEventListener("click", (event) => {
      if (event.target === wrap) finish(false);
    });
    wrap.querySelector("[data-cancel]").onclick = () => finish(false);
    wrap.querySelector("[data-ok]").onclick = () => finish(true);
    const focusEl = danger
      ? wrap.querySelector("[data-cancel]")
      : wrap.querySelector("[data-ok]");
    focusEl?.focus();
  });
}

export function textPrompt({
  title = "Enter a value",
  body = "",
  label = "Value",
  value = "",
  placeholder = "",
  confirmLabel = "Insert",
} = {}) {
  return new Promise((resolve) => {
    const { dialogs } = ensureRoots();
    dismissDialog(null);
    const previous = document.activeElement;
    const wrap = document.createElement("div");
    wrap.className = "dialog";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-labelledby", "dialogTitle");
    wrap.innerHTML = `
      <div class="dialog-card">
        <h3 id="dialogTitle">${escapeHtml(title)}</h3>
        ${body ? `<p>${escapeHtml(body)}</p>` : ""}
        <div class="field"><label>${escapeHtml(label)}</label>
          <input data-prompt-input value="${escapeHtml(value)}" placeholder="${escapeHtml(
            placeholder,
          )}" autocomplete="off" /></div>
        <div class="dialog-actions">
          <button type="button" class="btn" data-cancel>Cancel</button>
          <button type="button" class="btn btn-primary" data-ok>${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    dialogs.innerHTML = "";
    dialogs.appendChild(wrap);
    const input = wrap.querySelector("[data-prompt-input]");
    const finish = (next) => {
      if (pendingClose !== finish) return;
      pendingClose = null;
      dialogs.innerHTML = "";
      document.removeEventListener("keydown", onKey);
      if (previous && typeof previous.focus === "function") {
        try {
          previous.focus();
        } catch {
          // ignore
        }
      }
      resolve(next);
    };
    pendingClose = finish;
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(null);
      }
    };
    document.addEventListener("keydown", onKey);
    wrap.addEventListener("click", (event) => {
      if (event.target === wrap) finish(null);
    });
    wrap.querySelector("[data-cancel]").onclick = () => finish(null);
    wrap.querySelector("[data-ok]").onclick = () => finish(String(input.value || "").trim());
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        wrap.querySelector("[data-ok]").click();
      }
    });
    input.focus();
    input.select();
  });
}

export function showCopyDialog(value) {
  const text = String(value ?? "");
  return new Promise((resolve) => {
    const { dialogs } = ensureRoots();
    dismissDialog(false);
    const previous = document.activeElement;
    const wrap = document.createElement("div");
    wrap.className = "dialog";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-labelledby", "dialogTitle");
    wrap.innerHTML = `
      <div class="dialog-card">
        <h3 id="dialogTitle">Copy this link</h3>
        <p>Select the text and copy it, or use the button below.</p>
        <div class="dialog-copy">
          <input data-copy-input readonly value="${escapeHtml(text)}" />
        </div>
        <div class="dialog-actions">
          <button type="button" class="btn" data-cancel>Done</button>
          <button type="button" class="btn btn-primary" data-ok>Copy</button>
        </div>
      </div>`;
    dialogs.innerHTML = "";
    dialogs.appendChild(wrap);

    const input = wrap.querySelector("[data-copy-input]");
    const finish = () => {
      if (pendingClose !== finish) return;
      pendingClose = null;
      dialogs.innerHTML = "";
      document.removeEventListener("keydown", onKey);
      if (previous && typeof previous.focus === "function") {
        try {
          previous.focus();
        } catch {
          // ignore
        }
      }
      resolve();
    };
    pendingClose = finish;

    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish();
      }
    };
    document.addEventListener("keydown", onKey);
    wrap.addEventListener("click", (event) => {
      if (event.target === wrap) finish();
    });
    wrap.querySelector("[data-cancel]").onclick = finish;
    wrap.querySelector("[data-ok]").onclick = async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast("Copied", { variant: "ok" });
        finish();
      } catch {
        input.focus();
        input.select();
      }
    };
    input.focus();
    input.select();
  });
}

export function linkDialog({
  title = "Edit link",
  url = "",
  label = "",
  allowRemove = true,
} = {}) {
  return new Promise((resolve) => {
    const { dialogs } = ensureRoots();
    dismissDialog(null);
    const previous = document.activeElement;
    const wrap = document.createElement("div");
    wrap.className = "dialog";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-labelledby", "dialogTitle");
    wrap.innerHTML = `
      <div class="dialog-card">
        <h3 id="dialogTitle">${escapeHtml(title)}</h3>
        <p>${
          allowRemove
            ? "Change the URL or label, or remove this card from the section."
            : "This becomes a card in the section. Crew open it with Click Link."
        }</p>
        <div class="notice error" data-link-error hidden></div>
        <div class="field"><label>URL</label>
          <input data-link-url type="url" value="${escapeHtml(url)}" placeholder="https://" autocomplete="off" /></div>
        <div class="field"><label>Label (optional)</label>
          <input data-link-label value="${escapeHtml(label)}" placeholder="Stage plot" maxlength="200" autocomplete="off" /></div>
        <div class="dialog-actions dialog-actions-split">
          ${
            allowRemove
              ? `<button type="button" class="btn btn-danger" data-remove>Remove</button>`
              : `<span></span>`
          }
          <div class="dialog-actions-end">
            <button type="button" class="btn" data-cancel>Cancel</button>
            <button type="button" class="btn btn-primary" data-ok>${
              allowRemove ? "Save" : "Add"
            }</button>
          </div>
        </div>
      </div>`;
    dialogs.innerHTML = "";
    dialogs.appendChild(wrap);

    const urlInput = wrap.querySelector("[data-link-url]");
    const labelInput = wrap.querySelector("[data-link-label]");
    const errEl = wrap.querySelector("[data-link-error]");

    const finish = (value) => {
      if (pendingClose !== finish) return;
      pendingClose = null;
      dialogs.innerHTML = "";
      document.removeEventListener("keydown", onKey);
      if (previous && typeof previous.focus === "function") {
        try {
          previous.focus();
        } catch {
          // ignore
        }
      }
      resolve(value);
    };
    pendingClose = finish;

    const onKey = (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(null);
      }
    };
    document.addEventListener("keydown", onKey);
    wrap.addEventListener("click", (event) => {
      if (event.target === wrap) finish(null);
    });
    wrap.querySelector("[data-cancel]").onclick = () => finish(null);
    wrap.querySelector("[data-remove]")?.addEventListener("click", () =>
      finish({ action: "remove" }),
    );
    wrap.querySelector("[data-ok]").onclick = () => {
      const nextUrl = String(urlInput.value || "").trim();
      if (!isHttpUrl(nextUrl)) {
        errEl.hidden = false;
        errEl.textContent = "Enter a valid http(s) link.";
        urlInput.focus();
        return;
      }
      finish({
        action: "save",
        url: nextUrl,
        label: String(labelInput.value || "").trim(),
      });
    };
    urlInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        wrap.querySelector("[data-ok]").click();
      }
    });
    labelInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        wrap.querySelector("[data-ok]").click();
      }
    });
    urlInput.focus();
    urlInput.select();
  });
}

export async function copyText(value, { successMessage = "Copied", silent = false } = {}) {
  const text = String(value ?? "");
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    if (!silent) toast(successMessage, { variant: "ok" });
    return true;
  } catch {
    await showCopyDialog(text);
    return false;
  }
}

const api = { toast, confirmDialog, textPrompt, showCopyDialog, linkDialog, copyText };
if (typeof window !== "undefined") window.AppUI = api;
export default api;
