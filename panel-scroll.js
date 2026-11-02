// "Back to top" button of the issue panel. The column that scrolls is the whole panel body on a narrow panel and only the
// main column (description and timeline) next to the Settings column on a wide one.
// Loaded before app.js; it relies on panelElements declared there.

const PANEL_TOP_SHOW_AFTER = 400;

function mainScroller(panel) {
  const content = panel.querySelector(".panel-content");
  return getComputedStyle(content).display === "grid" ? panel.querySelector(".panel-main") : content;
}

function updatePanelTop(panel, button) {
  button.hidden = panel.hidden || mainScroller(panel).scrollTop < PANEL_TOP_SHOW_AFTER;
}

function setupPanelScroll(panel) {
  const button = panelElements.top;
  const update = () => updatePanelTop(panel, button);
  // Scroll events do not bubble, but they can be captured.
  panel.addEventListener("scroll", update, { capture: true, passive: true });
  new ResizeObserver(update).observe(panel);
  button.addEventListener("click", () => {
    const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    mainScroller(panel).scrollTo({ top: 0, behavior: smooth ? "smooth" : "auto" });
  });
}
