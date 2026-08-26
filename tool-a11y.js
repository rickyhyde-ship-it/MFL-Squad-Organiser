(function () {
  "use strict";
  let scheduled = false;
  let framePrepared = false;

  function prepareFrame() {
    if (framePrepared || !document.body) return;
    framePrepared = true;

    document.documentElement.classList.add("agent-tool-js");
    document.body.classList.add("agent-tool-frame");

    const revealSelectors = [
      "body > .header",
      "body > .shell > .header",
      "body > .marketplace-shell > .marketplace-header",
      "body > .global-shell > .header",
      "body > .strength-shell > .strength-header",
      "body > .hq-shell > .hq-header",
      "body > .container > .header",
      "body > #uploadScreen",
      "body > #app",
      ".controls",
      ".mode-tabs-wrap",
      ".marketplace-layout",
      ".leaderboard-layout",
      ".summary-grid",
      ".summary-strip",
      ".planner-shell",
      ".table-panel",
      ".table-wrapper",
      ".results-panel",
      ".panel",
      ".section"
    ];

    const revealTargets = [...new Set(
      revealSelectors.flatMap((selector) => [...document.querySelectorAll(selector)])
    )].filter((element) => !element.closest(".modal, .modal-overlay"));

    revealTargets.forEach((element, index) => {
      element.dataset.agentReveal = "";
      element.style.setProperty("--agent-reveal-index", String(Math.min(index, 10)));
    });

    requestAnimationFrame(() => {
      requestAnimationFrame(() => document.body.classList.add("agent-tool-ready"));
    });
  }

  function enhance() {
    scheduled = false;
    document.querySelectorAll("input, select, textarea").forEach((control) => {
      if (control.labels?.length || control.getAttribute("aria-label") || control.getAttribute("aria-labelledby")) return;
      const label = control.getAttribute("placeholder") || control.name || control.id;
      if (label) control.setAttribute("aria-label", String(label).replace(/[-_]+/g, " "));
    });
    document.querySelectorAll(".status, .status-line, .status-text, [id*='status' i]").forEach((status) => {
      if (!status.hasAttribute("role")) status.setAttribute("role", "status");
      if (!status.hasAttribute("aria-live")) status.setAttribute("aria-live", "polite");
    });
    document.querySelectorAll("table").forEach((table) => {
      if (table.querySelector(":scope > caption")) return;
      const caption = document.createElement("caption");
      caption.className = "sr-only";
      caption.textContent = table.getAttribute("aria-label") || "Tool data table";
      table.prepend(caption);
    });
    const modalSelector = ".modal, .modal-content, .modal-overlay, [class*='modal'][hidden]";
    [...document.querySelectorAll(modalSelector)]
      .filter((modal) => !modal.parentElement?.closest(modalSelector))
      .forEach((modal) => {
        if (!modal.hasAttribute("role")) modal.setAttribute("role", "dialog");
        modal.setAttribute("aria-modal", "true");
        const title = modal.querySelector(".modal-title, h1, h2, h3");
        if (title && !modal.getAttribute("aria-label") && !modal.getAttribute("aria-labelledby")) {
          if (!title.id) title.id = `dialog-title-${Math.random().toString(36).slice(2, 9)}`;
          modal.setAttribute("aria-labelledby", title.id);
        }
      });
    document.querySelectorAll("[onclick]:not(button):not(a):not(input)").forEach((control) => {
      if (!control.hasAttribute("tabindex")) control.tabIndex = 0;
      if (!control.hasAttribute("role")) control.setAttribute("role", "button");
    });
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(enhance);
  }

  function start() {
    enhance();
    prepareFrame();
  }

  document.addEventListener("keydown", (event) => {
    const control = event.target.closest?.("[onclick][role='button']");
    if (control && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      control.click();
      return;
    }
    if (event.key !== "Escape") return;
    const dialog = [...document.querySelectorAll("[role='dialog']")].find((candidate) => {
      const style = getComputedStyle(candidate);
      return !candidate.hidden
        && candidate.getAttribute("aria-hidden") !== "true"
        && style.display !== "none"
        && style.visibility !== "hidden";
    });
    const close = dialog?.querySelector("[data-close-modal], [data-close-wallet], .modal-close, .close-btn");
    close?.click();
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
})();
