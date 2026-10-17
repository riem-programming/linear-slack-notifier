// Progressive enhancement for the admin pages. Every screen works without this file.
// Sheets: links marked [data-sheet] open their fragment in a native <dialog>; any failure falls back to normal navigation.
(() => {
  if (typeof HTMLDialogElement !== "function") return;
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-labelledby", "sheet-title");
  document.body.append(dialog);
  let opener = null;

  let busy = false;
  const load = async (url) => {
    if (busy) return;
    busy = true;
    clearTimeout(timer);
    try {
      await fetchSheet(url);
    } finally {
      busy = false;
    }
  };
  const fetchSheet = async (url) => {
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

  // Inside the dialog the project search filters rows on the client: every checkbox stays in the form, so nothing unsaved is lost.
  const fold = (text) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
  const filter = (input) => {
    const needle = fold(input.value);
    for (const row of dialog.querySelectorAll("[data-fold]")) row.hidden = needle !== "" && !row.dataset.fold.includes(needle);
  };
  // Pickers (form[data-live]) ask the server for fresh results while the user types; only the results block is swapped,
  // so the search field keeps focus and a picked radio stays picked when it is still listed.
  let timer = 0;
  let latest = 0;
  const refresh = async (form) => {
    const mine = ++latest;
    const url = new URL(form.action);
    url.searchParams.set("q", form.elements.q.value);
    try {
      const res = await fetch(url, { headers: { "X-Admin-Fragment": "1" }, credentials: "same-origin" });
      if (!res.ok || res.redirected || mine !== latest) return;
      const next = new DOMParser().parseFromString(await res.text(), "text/html").querySelector("[data-live-results]");
      const current = dialog.querySelector("[data-live-results]");
      if (!next || !current) return;
      const picked = current.querySelector("input[name=member]:checked")?.value;
      current.replaceWith(next);
      const paste = dialog.querySelector("details.paste");
      if (paste && !next.querySelector("input[name=member]")) paste.open = true;
      for (const radio of next.querySelectorAll("input[name=member]")) radio.checked = radio.value === picked;
    } catch {
      // Keep the current results; the form still submits normally.
    }
  };
  dialog.addEventListener("input", (event) => {
    if (!(event.target instanceof HTMLInputElement) || event.target.type !== "search") return;
    if (event.target.form?.matches("[data-live]")) {
      clearTimeout(timer);
      const form = event.target.form;
      timer = setTimeout(() => refresh(form), 250);
    } else filter(event.target);
  });
  dialog.addEventListener("submit", (event) => {
    if (event.target instanceof HTMLFormElement && event.target.matches("[data-sheet-search], [data-live]")) event.preventDefault();
  });

  dialog.addEventListener("close", () => {
    clearTimeout(timer);
    latest += 1;
    dialog.replaceChildren();
    if (opener instanceof HTMLElement) opener.focus();
  });
})();
