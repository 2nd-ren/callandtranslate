(() => {
  const KEY = "lpd-theme";
  let mode = "";
  try {
    mode = localStorage.getItem(KEY) || "";
  } catch {
    mode = "";
  }
  const resolved =
    mode === "light" || mode === "dark"
      ? mode
      : typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.documentElement.setAttribute("data-theme", resolved);
  document.documentElement.style.colorScheme = resolved;
})();
