// Small screens (smartphone): the issue panel is a full screen dialog, and its Settings fold into a strip under the title
// (assignees and flow) that expands in place, so they are never a long timeline away.
// Loaded before app.js; it relies on globals declared there and in panel-settings.js (panelElements, panelFlow, closePicker…).
// The CSS breakpoint of the full screen panel is the same one: keep them together.

const COMPACT_PANEL_QUERY = "(max-width: 700px)";
// The page behind a full screen panel; popups and dialogs are appended to the body and stay usable.
const PANEL_BACKGROUND = "body > .top-app-bar, body > main, body > .board-footer";
const compactPanelMedia = window.matchMedia(COMPACT_PANEL_QUERY);

let settingsOpen = false;

function isCompactPanel() {
  return compactPanelMedia.matches;
}

function setSettingsOpen(open) {
  settingsOpen = open;
  if (!panelElements) return;
  panelElements.settings.classList.toggle("is-open", open);
  panelElements.settingsToggle.setAttribute("aria-expanded", String(open));
  if (!open) closePicker(false);
}

// A new issue starts with its Settings open, as it has required labels; an existing issue starts with them folded.
function resetSettingsOpen(issue) {
  setSettingsOpen(Boolean(issue.draft));
}

// Settings sit under the title on a small screen and in their own column (or below) otherwise.
function syncCompactPanel() {
  if (!panelElements) return;
  const { panel, settings, descCard } = panelElements;
  const compact = isCompactPanel();
  const parent = compact ? panel.querySelector(".panel-main") : panel.querySelector(".panel-content");
  if (settings.parentElement !== parent) {
    closePicker(false);
    if (compact) parent.insertBefore(settings, descCard);
    else parent.append(settings);
  }
  const modal = compact && !panel.hidden;
  if (modal) panel.setAttribute("aria-modal", "true");
  else panel.removeAttribute("aria-modal");
  document.querySelectorAll(PANEL_BACKGROUND).forEach((element) => {
    element.inert = modal;
  });
}

function renderSettingsSummary(issue) {
  const assigned = issue.assignees || [];
  const people = assigned.length === 0 ? '<span class="summary-empty">No assignee</span>' : avatarsHtml(issue, 24);
  const flow = panelFlow(issue);
  panelElements.settingsSummary.innerHTML = `
    <span class="summary-item">${people}${assigned.length > 3 ? `<span class="summary-more">+${assigned.length - 3}</span>` : ""}</span>
    <span class="summary-item"><span class="summary-label">Flow</span>${flow ? escapeHtml(flow) : '<span class="summary-empty">None</span>'}</span>`;
}

// A required label that is missing sits in the Settings: they must be open to show it.
function revealSettings() {
  if (isCompactPanel() && !settingsOpen) setSettingsOpen(true);
}

function setupCompactPanel() {
  const { settingsToggle } = panelElements;
  settingsToggle.addEventListener("click", () => setSettingsOpen(!settingsOpen));
  compactPanelMedia.addEventListener("change", syncCompactPanel);
  syncCompactPanel();
}
