// Tabs of the side panel: several issues can be open at once (relationships and #N references open a new tab).
// Loaded before app.js; it relies on globals declared there and in timeline.js, description.js and panel-settings.js.
//
// The panel itself is still a single set of globals (panelIssueId, panelMeta, panelTimeline, descriptionView…).
// The active tab lives in them; when the user leaves a tab, its state is saved in `tab.saved` and put back on return.

// One entry per tab, left to right: { id, issue, saved }. `saved` is null for the active tab.
let panelTabs = [];
let renderedTabs = "";
let scrolledToTab = null;
let tabsMenu = null;
const tabsOpening = new Set();

function startPanelTabs(issue) {
  panelTabs = [{ id: issue.id, issue, saved: null }];
  renderedTabs = "";
  scrolledToTab = null;
}

function endPanelTabs() {
  panelTabs = [];
  renderedTabs = "";
  scrolledToTab = null;
  if (tabsMenu) tabsMenu.open = false;
}

function isTabIssue(id) {
  return panelTabs.some((tab) => tab.id === id);
}

// Tab issues must stay in `issues` (the panel looks them up there) even when a reload or a sync does not list them.
function pinTabIssues() {
  for (const tab of panelTabs) {
    if (tab.id === DRAFT_ID) continue;
    const current = issues.find((item) => item.id === tab.id);
    if (current) tab.issue = current;
    else issues.push(tab.issue);
  }
}

function tabIssue(tab) {
  if (tab.id === DRAFT_ID) return draftIssue;
  return issues.find((item) => item.id === tab.id) || tab.issue;
}

function findTab(id) {
  return panelTabs.find((tab) => String(tab.id) === String(id));
}

/* ---------- Saved state of a tab ---------- */

function scrollers() {
  return [".panel-content", ".panel-main", ".panel-settings"].map((selector) => panelElements.panel.querySelector(selector));
}

function resetPanelScroll() {
  scrollers().forEach((element) => {
    element.scrollTop = 0;
  });
}

function snapshotPanelState() {
  const issue = currentIssue();
  return {
    meta: panelMeta,
    errors: panelErrors,
    title: panelElements.title.value,
    body: descriptionEditor.value,
    base: issue ? { title: issue.title, body: issue.body || "" } : null,
    descriptionMode,
    descriptionView,
    timeline: panelTimeline,
    composer: timelineUi ? timelineUi.editor.value : "",
    scroll: scrollers().map((element) => element.scrollTop)
  };
}

function savedTabHasUnsavedChanges(tab) {
  const saved = tab.saved;
  const issue = tabIssue(tab);
  if (!saved || !issue) return false;
  if (issue.draft) {
    return Boolean(saved.title.trim() || saved.body.trim() || issue.labels.length || issue.assignees.length || relationCount(issue.relationships));
  }
  const edited = saved.title.trim() !== saved.base.title || saved.body !== saved.base.body;
  const typing = Boolean(saved.composer.trim()) && !saved.timeline.postedWhileAway;
  const editing = [...saved.timeline.editors.values()].some((entry) => entry.editor.value !== entry.original);
  return edited || typing || editing;
}

function tabHasUnsavedChanges(tab) {
  return tab.id === panelIssueId ? hasUnsavedChanges() : savedTabHasUnsavedChanges(tab);
}

function anyTabHasUnsavedChanges() {
  return panelTabs.some(tabHasUnsavedChanges);
}

// Called by showPanelIssue once the panel was reset for the issue, before it is rendered.
function restorePanelState(issue, saved) {
  const { title } = panelElements;
  const edited = issue.draft || saved.title.trim() !== saved.base.title || saved.body !== saved.base.body;
  descriptionMode = saved.descriptionMode;
  if (edited) {
    title.value = saved.title;
    descriptionEditor.value = saved.body;
    if (!issue.draft && (issue.title !== saved.base.title || (issue.body || "") !== saved.base.body)) {
      showPanelError("Someone else changed this issue on GitHub. Your unsaved edits are kept, and saving will replace their version.");
    }
  }
  if (saved.descriptionView.status === "ready" && saved.descriptionView.key === `${issue.id}|${Boolean(accessToken)}`) {
    descriptionView = saved.descriptionView;
    descriptionView.shown = null;
  }
  const timeline = saved.timeline;
  if (timeline.status === "ready" && timeline.key === `${issue.id}|${Boolean(accessToken)}`) {
    panelTimeline = timeline;
    timeline.loadingOlder = false;
    if (!timeline.postedWhileAway) timelineUi.editor.value = saved.composer;
    timeline.postedWhileAway = false;
  } else if (!issue.draft) {
    timelineUi.editor.value = saved.composer;
  }
}

// Called by showPanelIssue after the first render of the restored tab.
function finishPanelRestore(saved) {
  renderTimeline();
  refreshTimeline();
  refreshDescription();
  scrollers().forEach((element, index) => {
    element.scrollTop = saved.scroll[index];
  });
}

/* ---------- Opening, switching and closing ---------- */

function openIssueTab(issue) {
  if (!issue.draft && !issues.some((item) => item.id === issue.id)) issues.push(issue);
  if (!findTab(issue.id)) panelTabs.push({ id: issue.id, issue, saved: null });
  switchToTab(issue.id);
}

function switchToTab(id) {
  const target = findTab(id);
  const current = panelTabs.find((tab) => tab.id === panelIssueId);
  if (!target || target === current) return;
  if (current) current.saved = snapshotPanelState();
  const saved = target.saved;
  target.saved = null;
  showPanelIssue(tabIssue(target), saved);
}

function removePanelTab(id) {
  const index = panelTabs.findIndex((tab) => String(tab.id) === String(id));
  if (index === -1) return;
  const [tab] = panelTabs.splice(index, 1);
  if (panelTabs.length === 0) {
    closePanel();
    return;
  }
  // The neighbor on the right takes over, or the one on the left for the last tab.
  if (tab.id === panelIssueId) switchToTab(panelTabs[Math.min(index, panelTabs.length - 1)].id);
  if (tab.id === DRAFT_ID) draftIssue = null;
  renderPanelTabs();
}

async function closeTab(id) {
  const tab = findTab(id);
  if (!tab || panelClosing) return;
  panelClosing = true;
  try {
    if (!tabHasUnsavedChanges(tab) || (await confirmDiscard())) removePanelTab(tab.id);
  } finally {
    panelClosing = false;
  }
}

// Relationship rows and #N references name an issue by its repository and number; it may not be loaded yet.
async function openIssueByReference({ repo, number, url }) {
  const wanted = repo.toLowerCase();
  const known = issues.find((item) => item.number === number && repoOf(item).join("/").toLowerCase() === wanted);
  if (known) {
    openIssueTab(known);
    return;
  }
  // Only the organization's issues are loaded by the dashboard; others stay on GitHub.
  if (wanted.split("/")[0] !== ORGANIZATION) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const key = `${wanted}#${number}`;
  if (tabsOpening.has(key)) return;
  tabsOpening.add(key);
  try {
    const issue = await githubRequest(issueApiUrl(repo, number), {}, accessToken);
    if (issue.pull_request) {
      window.open(url, "_blank", "noopener");
      return;
    }
    if (panelIssueId === null) return;
    openIssueTab(issues.find((item) => item.id === issue.id) || issue);
  } catch (error) {
    showPanelError(`Could not open ${displayRepo(repo)}#${number}: ${apiErrorMessage(error)}`);
  } finally {
    tabsOpening.delete(key);
  }
}

/* ---------- Tab bar ---------- */

function tabParts(tab) {
  const issue = tabIssue(tab);
  if (issue.draft) return { ref: "New issue", title: "New issue", status: { key: "draft", icon: "edit_square", label: "Draft" } };
  return {
    ref: `${displayRepo(repoOf(issue).join("/"))} #${issue.number}`,
    title: issue.title,
    status: issueStatus(issue)
  };
}

function tabHtml(tab, closable) {
  const { ref, title, status } = tabParts(tab);
  const active = tab.id === panelIssueId;
  const dirty = !active && savedTabHasUnsavedChanges(tab);
  const label = `${ref}: ${title}. ${status.label}${dirty ? ". Unsaved changes" : ""}`;
  const id = escapeHtml(String(tab.id));
  return `<div class="panel-tab${active ? " is-active" : ""}" data-tab-id="${id}">
    <button type="button" class="panel-tab-main" role="tab" aria-selected="${active}" tabindex="${active ? 0 : -1}" title="${escapeHtml(title)}" aria-label="${escapeHtml(label)}" aria-keyshortcuts="Delete">
      <md-icon class="status-icon status-${status.key}" aria-hidden="true">${status.icon}</md-icon>
      <span class="panel-tab-label">${escapeHtml(ref)}</span>${dirty ? '<span class="panel-tab-dirty" aria-hidden="true"></span>' : ""}
    </button>${closable ? `<button type="button" class="panel-tab-close" tabindex="-1" aria-label="Close ${escapeHtml(ref)}" title="Close tab"><md-icon aria-hidden="true">close</md-icon></button>` : ""}
  </div>`;
}

function renderPanelTabs() {
  if (!panelElements || panelTabs.length === 0) return;
  const { tabList } = panelElements;
  const html = panelTabs.map((tab) => tabHtml(tab, panelTabs.length > 1)).join("");
  if (html !== renderedTabs) {
    const focused = tabList.contains(document.activeElement) ? document.activeElement.closest("[data-tab-id]")?.dataset.tabId : null;
    const left = tabList.scrollLeft;
    tabList.innerHTML = html;
    tabList.scrollLeft = left;
    renderedTabs = html;
    if (focused !== null && focused !== undefined) tabList.querySelector(".is-active .panel-tab-main")?.focus({ preventScroll: true });
  }
  if (scrolledToTab !== panelIssueId) {
    scrolledToTab = panelIssueId;
    scrollActiveTabIntoView();
  }
  updateTabOverflow();
}

function scrollActiveTabIntoView() {
  const { tabList } = panelElements;
  const active = tabList.querySelector(".is-active");
  if (!active) return;
  const margin = 28;
  const left = active.offsetLeft - tabList.offsetLeft;
  const right = left + active.offsetWidth;
  const wider = active.offsetWidth + margin > tabList.clientWidth;
  if (wider || left - margin < tabList.scrollLeft) tabList.scrollLeft = Math.max(0, left - margin);
  else if (right + margin > tabList.scrollLeft + tabList.clientWidth) tabList.scrollLeft = right + margin - tabList.clientWidth;
}

// Fade edges show that more tabs hide on a side; the "all issues" menu appears once they do not all fit.
function updateTabOverflow() {
  if (!panelElements) return;
  const { tabs, tabList, tabsAll } = panelElements;
  const overflowing = tabList.scrollWidth > tabList.clientWidth + 1;
  tabs.classList.toggle("can-scroll-start", tabList.scrollLeft > 1);
  tabs.classList.toggle("can-scroll-end", overflowing && tabList.scrollLeft + tabList.clientWidth < tabList.scrollWidth - 1);
  tabsAll.hidden = !overflowing;
}

function openTabsMenu() {
  tabsMenu.innerHTML = panelTabs
    .map((tab) => {
      const { ref, title, status } = tabParts(tab);
      const selected = tab.id === panelIssueId ? " selected" : "";
      return `<md-menu-item data-tab-id="${escapeHtml(String(tab.id))}"${selected}>
        <md-icon slot="start" class="status-icon status-${status.key}">${status.icon}</md-icon>
        <div slot="headline">${escapeHtml(ref)}</div>
        <div slot="supporting-text">${escapeHtml(title)}</div>
      </md-menu-item>`;
    })
    .join("");
  tabsMenu.open = true;
}

function setupPanelTabs(panel) {
  const { tabList, tabsAll } = panelElements;

  tabList.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-tab-id]");
    if (!tab) return;
    if (event.target.closest(".panel-tab-close")) closeTab(tab.dataset.tabId);
    else switchToTab(tab.dataset.tabId);
  });
  // Middle click closes a tab, as in a browser.
  tabList.addEventListener("mousedown", (event) => {
    if (event.button === 1 && event.target.closest("[data-tab-id]")) event.preventDefault();
  });
  tabList.addEventListener("auxclick", (event) => {
    const tab = event.target.closest("[data-tab-id]");
    if (event.button === 1 && tab && panelTabs.length > 1) {
      event.preventDefault();
      closeTab(tab.dataset.tabId);
    }
  });
  tabList.addEventListener("keydown", (event) => {
    const current = event.target.closest("[data-tab-id]");
    if (!current) return;
    const index = panelTabs.findIndex((tab) => String(tab.id) === current.dataset.tabId);
    if (event.key === "Delete" && panelTabs.length > 1) {
      event.preventDefault();
      closeTab(current.dataset.tabId);
      return;
    }
    const targets = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: panelTabs.length - 1 };
    if (!(event.key in targets)) return;
    event.preventDefault();
    const target = panelTabs[Math.min(panelTabs.length - 1, Math.max(0, targets[event.key]))];
    switchToTab(target.id);
    tabList.querySelector(".is-active .panel-tab-main")?.focus();
  });
  // The wheel scrolls the tabs sideways, which is what a mouse user expects from a tab strip.
  tabList.addEventListener(
    "wheel",
    (event) => {
      if (tabList.scrollWidth <= tabList.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      tabList.scrollLeft += event.deltaY;
    },
    { passive: false }
  );
  tabList.addEventListener("scroll", updateTabOverflow, { passive: true });
  new ResizeObserver(() => {
    scrollActiveTabIntoView();
    updateTabOverflow();
  }).observe(tabList);

  tabsMenu = document.createElement("md-menu");
  tabsMenu.setAttribute("positioning", "popover");
  tabsMenu.quick = true;
  tabsMenu.anchorElement = tabsAll;
  tabsAll.after(tabsMenu);
  const syncExpanded = () => tabsAll.setAttribute("aria-expanded", String(tabsMenu.open));
  tabsAll.addEventListener("click", () => {
    if (tabsMenu.open) tabsMenu.open = false;
    else openTabsMenu();
    syncExpanded();
  });
  // Escape closes the menu only; the document handler would otherwise close the whole panel.
  tabsMenu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") event.stopPropagation();
  });
  tabsMenu.addEventListener("opened", syncExpanded);
  tabsMenu.addEventListener("closed", syncExpanded);
  tabsMenu.addEventListener("close-menu", (event) => {
    const id = event.detail.initiator?.dataset?.tabId;
    if (id !== undefined) switchToTab(id);
  });

  // A relationship row or a #N reference of a description or comment opens in a tab. Modified clicks keep opening GitHub.
  panel.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const relation = event.target.closest("a.relation-link");
    if (relation) {
      event.preventDefault();
      openIssueByReference({ repo: relation.dataset.repo, number: Number(relation.dataset.number), url: relation.href });
      return;
    }
    const link = event.target.closest(".desc-body a.issue-link, .tl-comment-body a.issue-link");
    const match = link && /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/(\d+)(?:[/?#]|$)/.exec(link.dataset.url || link.href);
    if (!match) return;
    event.preventDefault();
    openIssueByReference({ repo: match[1], number: Number(match[2]), url: link.href });
  });
}
