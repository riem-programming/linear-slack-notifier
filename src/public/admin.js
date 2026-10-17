// Progressive enhancement for the admin pages. Every screen works without this file.
// Sheets: links marked [data-sheet] open their fragment in a native <dialog>; any failure falls back to normal navigation.
(() => {
  if (typeof HTMLDialogElement !== "function") return;
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-labelledby", "sheet-title");
  document.body.append(dialog);
  let opener = null;

  const load = async (url) => {
    const res = await fetch(url, { headers: { "X-Admin-Fragment": "1" }, credentials: "same-origin" });
    // A redirect means the session ended: let the browser navigate to the real page instead.
    if (!res.ok || res.redirected) throw new Error("sheet unavailable");
    dialog.innerHTML = await res.text();
    if (!dialog.open) dialog.showModal();
    dialog.querySelector("input[type=search]")?.focus();
  };

  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a[data-sheet]") : null;
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    opener = link;
    load(link.href).catch(() => { window.location.href = link.href; });
  });

  dialog.addEventListener("click", (event) => {
    // The dialog has no padding, so a click on the dialog itself is a click on the backdrop.
    if (event.target === dialog || (event.target instanceof Element && event.target.closest("[data-close]"))) {
      event.preventDefault();
      dialog.close();
    }
  });

  dialog.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.matches("[data-sheet-search]")) return;
    event.preventDefault();
    const url = `${form.action}?${new URLSearchParams(new FormData(form))}`;
    load(url).catch(() => { window.location.href = url; });
  });

  dialog.addEventListener("close", () => {
    dialog.replaceChildren();
    if (opener instanceof HTMLElement) opener.focus();
  });
})();
