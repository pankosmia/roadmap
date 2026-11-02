// "Pull requests" menu: every open pull request of the organization, with the issue it is linked to (Development area), if any.
// Loaded after development.js; it relies on globals declared there and in app.js (accessToken, githubRequest, escapeHtml…).
// The menu reuses the notif-* styles and positionNotificationsMenu() of notifications.js, which is loaded after it.

const OPEN_PULLS_PAGE_SIZE = 100;
const OPEN_PULLS_MAX_PAGES = 10;
const OPEN_PULLS_TTL = 5 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// Alert thresholds, in calendar hours.
const DRAFT_ALERT_HOURS = 30 * 24;
const REVIEW_ALERT_HOURS = 48;
const OPEN_PULLS_QUERY = `query($search: String!, $cursor: String) {
  search(query: $search, type: ISSUE, first: ${OPEN_PULLS_PAGE_SIZE}, after: $cursor) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number title url isDraft createdAt
        reviewRequests { totalCount }
        reviews { totalCount }
        draftEvents: timelineItems(last: 1, itemTypes: [CONVERT_TO_DRAFT_EVENT]) { nodes { ... on ConvertToDraftEvent { createdAt } } }
        reviewEvents: timelineItems(last: 1, itemTypes: [REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT]) { nodes { ... on ReviewRequestedEvent { createdAt } ... on ReadyForReviewEvent { createdAt } } }
        author { login }
        repository { nameWithOwner }
        closingIssuesReferences(first: 10) { nodes { number title url repository { nameWithOwner } } }
      }
    }
  }
}`;

const OPEN_PULLS_CACHE_KEY = "roadmap-open-pulls-cache";
const OPEN_PULLS_TAB_KEY = "roadmap-pulls-tab";
// How often the "Updated … ago" text of an open menu is recomputed.
const MENU_TIME_REFRESH_MS = 30 * 1000;

function readOpenPullsTab() {
  try {
    return localStorage.getItem(OPEN_PULLS_TAB_KEY) === "alerts" ? "alerts" : "all";
  } catch {
    return "all";
  }
}

function saveOpenPullsTab() {
  try {
    localStorage.setItem(OPEN_PULLS_TAB_KEY, openPullsTab);
  } catch {
    // Storage may be unavailable; the choice then lasts only for this page view.
  }
}

// Shared with notifications.js: the "Updated … ago" text next to the filter of a menu (empty until a list was loaded).
function menuUpdatedText(time) {
  if (!time) return "";
  const minutes = Math.floor((Date.now() - time) / 60000);
  if (minutes < 1) return "Updated just now";
  return minutes < 60 ? `Updated ${minutes} min ago` : `Updated ${Math.floor(minutes / 60)} h ago`;
}

function updateMenuTime(element, time) {
  const label = element.querySelector(".notif-updated");
  const text = menuUpdatedText(time);
  label.textContent = text;
  label.hidden = text === "";
}

function readOpenPullsCache() {
  try {
    const cached = JSON.parse(sessionStorage.getItem(OPEN_PULLS_CACHE_KEY));
    return cached && Array.isArray(cached.items) ? cached : null;
  } catch {
    return null;
  }
}

function saveOpenPullsCache() {
  try {
    sessionStorage.setItem(OPEN_PULLS_CACHE_KEY, JSON.stringify(openPulls));
  } catch {
    // Storage may be unavailable or full; the list is then fetched again on each page view.
  }
}

function clearOpenPullsCache() {
  try {
    sessionStorage.removeItem(OPEN_PULLS_CACHE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

// The cached list is shown at once after a page change; loadOpenPulls refreshes it when it is stale.
let openPulls = readOpenPullsCache() || { time: 0, items: [], total: 0 };
let openPullsRun = 0;
let openPullsMenu = null;
let openPullsLoading = false;
let openPullsError = "";
let openPullsTab = readOpenPullsTab();

// A pull request alerts when it has been a draft for a month, or has waited 48 hours for a review.
// Drafting counts from the last "convert to draft" (else creation); waiting counts from the last
// review request or "ready for review" (else creation).
function openPullAlert(node) {
  const now = Date.now();
  if (node.isDraft) {
    const since = node.draftEvents.nodes[0]?.createdAt || node.createdAt;
    const hours = (now - Date.parse(since)) / HOUR_MS;
    return hours >= DRAFT_ALERT_HOURS ? { kind: "draft", text: `Draft for ${durationText(hours)}` } : null;
  }
  const isWaiting = node.reviewRequests.totalCount > 0 || node.reviews.totalCount === 0;
  if (!isWaiting) return null;
  const since = node.reviewEvents.nodes[0]?.createdAt || node.createdAt;
  const hours = (now - Date.parse(since)) / HOUR_MS;
  return hours >= REVIEW_ALERT_HOURS ? { kind: "review", text: `Waiting for review for ${durationText(hours)}` } : null;
}

function durationText(hours) {
  return hours < 48 ? `${Math.floor(hours)} h` : `${Math.floor(hours / 24)} days`;
}

function openPullFromNode(node) {
  return {
    alert: openPullAlert(node),
    number: node.number,
    title: node.title,
    url: node.url,
    state: node.isDraft ? "DRAFT" : "OPEN",
    repo: node.repository.nameWithOwner,
    author: node.author?.login || "ghost",
    createdAt: node.createdAt,
    issues: node.closingIssuesReferences.nodes.map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      repo: issue.repository.nameWithOwner
    }))
  };
}

async function fetchOpenPulls(run) {
  const items = [];
  let cursor = null;
  let total = 0;
  for (let page = 0; page < OPEN_PULLS_MAX_PAGES; page += 1) {
    const result = await githubRequest(
      `${API_ROOT}/graphql`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: OPEN_PULLS_QUERY, variables: { search: `org:${ORGANIZATION} is:pr is:open sort:created-desc`, cursor } })
      },
      accessToken
    );
    if (run !== openPullsRun) return null;
    if (!result.data) throw new Error(result.errors?.[0]?.message || "No data returned.");
    const { nodes, pageInfo, issueCount } = result.data.search;
    total = issueCount;
    items.push(...nodes.filter((node) => node && node.number).map(openPullFromNode));
    if (!pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }
  return { items, total };
}

async function loadOpenPulls({ force = false } = {}) {
  if (!accessToken || openPullsLoading) return;
  if (!force && Date.now() - openPulls.time < OPEN_PULLS_TTL) {
    // The cached list is fresh: show its alerts without fetching.
    renderOpenPulls();
    return;
  }
  const run = ++openPullsRun;
  openPullsLoading = true;
  openPullsError = "";
  renderOpenPulls();
  try {
    const result = await fetchOpenPulls(run);
    if (result) {
      openPulls = { time: Date.now(), ...result };
      saveOpenPullsCache();
    }
  } catch (error) {
    if (run === openPullsRun) openPullsError = apiErrorMessage(error);
  }
  if (run !== openPullsRun) return;
  openPullsLoading = false;
  renderOpenPulls();
}

function clearOpenPulls() {
  openPullsRun += 1;
  openPullsLoading = false;
  openPullsError = "";
  openPulls = { time: 0, items: [], total: 0 };
  clearOpenPullsCache();
  closeOpenPullsMenu(false);
  updatePullsBadge();
}

function openPullAgeText(createdAt) {
  const days = Math.floor((Date.now() - Date.parse(createdAt)) / 86400000);
  if (days < 1) return "today";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function updatePullsBadge() {
  const badge = document.querySelector("#pulls-badge");
  const button = document.querySelector("#pulls-button");
  if (!badge || !button) return;
  const count = accessToken ? openPulls.items.filter((pull) => pull.alert).length : 0;
  badge.hidden = count === 0;
  badge.textContent = count;
  const label = count === 0 ? "Pull requests" : `Pull requests, ${count} ${count === 1 ? "alert" : "alerts"}`;
  button.setAttribute("aria-label", label);
  button.title = label;
}

function openPullRowHtml(pull) {
  const state = pullState(pull);
  const linked = pull.issues.length > 0;
  const issueLinks = linked
    ? pull.issues
        .map(
          (issue) =>
            `<a class="pulls-issue-chip" href="${escapeHtml(issue.url)}" target="_blank" rel="noopener" title="${escapeHtml(issue.title)}"><md-icon>link</md-icon>${escapeHtml(displayRepo(issue.repo))}#${issue.number}</a>`
        )
        .join("")
    : '<span class="pulls-orphan-chip" title="Not linked to an issue in its Development area"><md-icon>link_off</md-icon>No issue</span>';
  const alertChip = pull.alert
    ? `<span class="pulls-alert-chip" title="${escapeHtml(pull.alert.text)}"><md-icon>warning</md-icon>${escapeHtml(pull.alert.text)}</span>`
    : "";
  return `
    <li class="notif-row pulls-row ${linked ? "pulls-linked" : "pulls-orphan"}">
      <a class="notif-open pulls-open" href="${escapeHtml(pull.url)}" target="_blank" rel="noopener">
        <md-icon class="notif-type ${state.className}" title="${state.text}">${state.icon}</md-icon>
        <span class="notif-text">
          <span class="notif-title">${escapeHtml(pull.title)}</span>
          <span class="notif-meta">${escapeHtml(displayRepo(pull.repo))}#${pull.number} · @${escapeHtml(pull.author)} · ${openPullAgeText(pull.createdAt)}</span>
        </span>
      </a>
      <span class="pulls-issues">${alertChip}${issueLinks}</span>
    </li>`;
}

function openPullsMessageHtml(icon, text, extra = "") {
  return `<li class="notif-empty"><md-icon>${icon}</md-icon><p>${text}</p>${extra}</li>`;
}

function renderOpenPulls() {
  updatePullsBadge();
  if (!openPullsMenu) return;
  const { element } = openPullsMenu;
  const list = element.querySelector(".notif-list");
  const status = element.querySelector(".notif-status");
  const refresh = element.querySelector(".notif-refresh");
  const items = accessToken ? openPulls.items : [];
  const alerts = items.filter((pull) => pull.alert);
  const shown = openPullsTab === "alerts" ? alerts : items;
  const hasList = accessToken && openPulls.time > 0;

  element.querySelector('[data-tab="all"]').textContent = `All (${items.length})`;
  const alertsTab = element.querySelector('[data-tab="alerts"]');
  alertsTab.textContent = `Alerts (${alerts.length})`;
  alertsTab.classList.toggle("has-alerts", alerts.length > 0);
  updateMenuTime(element, accessToken ? openPulls.time : 0);
  for (const tab of element.querySelectorAll(".notif-tab")) tab.setAttribute("aria-pressed", String(tab.dataset.tab === openPullsTab));
  // The refresh icon spins while loading; the button keeps its size and place, so nothing in the menu moves.
  refresh.disabled = !accessToken;
  refresh.classList.toggle("loading", openPullsLoading);
  refresh.setAttribute("aria-busy", String(openPullsLoading));

  const scrollTop = list.scrollTop;
  const focusedRow = list.contains(document.activeElement) ? document.activeElement.closest(".notif-row") : null;
  const focusedIndex = focusedRow ? [...list.children].indexOf(focusedRow) : -1;
  if (!accessToken) {
    list.innerHTML = openPullsMessageHtml("link_off", "Connect GitHub to list pull requests and their linked issues.", '<md-text-button class="pulls-connect" type="button">Connect GitHub</md-text-button>');
  } else if (openPullsLoading && openPulls.time === 0) {
    list.innerHTML = '<li class="notif-empty"><md-circular-progress indeterminate aria-label="Loading"></md-circular-progress></li>';
  } else if (openPullsError && openPulls.time === 0) {
    list.innerHTML = openPullsMessageHtml("error", `Pull requests could not be loaded: ${escapeHtml(openPullsError)}`, '<md-text-button class="pulls-retry" type="button">Retry</md-text-button>');
  } else if (shown.length === 0) {
    list.innerHTML =
      openPullsTab === "alerts"
        ? openPullsMessageHtml("task_alt", "No pull request needs attention.")
        : openPullsMessageHtml("merge_type", "No open pull request.");
  } else {
    list.innerHTML = shown.map(openPullRowHtml).join("");
  }

  const messages = [];
  if (hasList) messages.push(`${items.filter((pull) => pull.issues.length === 0).length} without a linked issue`);
  if (openPullsError && hasList) messages.push(`Could not refresh (${openPullsError}). Showing the last loaded list.`);
  if (hasList && openPulls.total > items.length) messages.push(`Showing the first ${items.length} of ${openPulls.total}.`);
  status.textContent = messages.join(" · ");
  status.hidden = messages.length === 0;

  list.scrollTop = scrollTop;
  // After a refresh the focused row is replaced: keep the keyboard where it was.
  if (focusedIndex >= 0 && !list.contains(document.activeElement)) {
    const targets = list.querySelectorAll(".notif-open");
    (targets[Math.min(focusedIndex, targets.length - 1)] || refresh).focus();
  }
}

function closeOpenPullsMenu(restoreFocus = true) {
  if (!openPullsMenu) return;
  const { element, trigger, onOutside, onKey, onViewport, timer } = openPullsMenu;
  clearInterval(timer);
  document.removeEventListener("pointerdown", onOutside, true);
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("scroll", onViewport, true);
  window.removeEventListener("resize", onViewport);
  element.remove();
  openPullsMenu = null;
  trigger.setAttribute("aria-expanded", "false");
  if (restoreFocus) trigger.focus();
}

function openPullsMenuKeys(event, element) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeOpenPullsMenu();
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const targets = [...element.querySelectorAll(".notif-open")];
  const index = targets.indexOf(document.activeElement);
  if (targets.length === 0 || (index < 0 && !element.contains(document.activeElement))) return;
  event.preventDefault();
  const next = event.key === "ArrowDown" ? index + 1 : index - 1;
  targets[Math.max(0, Math.min(targets.length - 1, next))].focus();
}

function handleOpenPullsClick(event) {
  const target = event.target;
  const tab = target.closest(".notif-tab");
  if (tab) {
    openPullsTab = tab.dataset.tab;
    saveOpenPullsTab();
    renderOpenPulls();
  } else if (target.closest(".notif-refresh") || target.closest(".pulls-retry")) loadOpenPulls({ force: true });
  else if (target.closest(".pulls-connect")) {
    closeOpenPullsMenu(false);
    openAuthDialog();
  }
}

function openOpenPullsMenu(trigger) {
  closeOpenPullsMenu(false);
  closeNotificationsMenu(false);
  const element = document.createElement("div");
  element.className = "notif-menu";
  element.setAttribute("popover", "manual");
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-label", "Pull requests");
  element.innerHTML = `
    <div class="notif-header">
      <h4>Pull requests</h4>
      <md-icon-button class="notif-refresh" aria-label="Refresh pull requests" title="Refresh"><md-icon>refresh</md-icon></md-icon-button>
    </div>
    <div class="notif-tabs">
      <div class="notif-tab-group" role="group" aria-label="Pull request filter">
        <button type="button" class="notif-tab" data-tab="all" aria-pressed="false"></button>
        <button type="button" class="notif-tab" data-tab="alerts" aria-pressed="false"></button>
      </div>
      <span class="notif-updated" hidden></span>
    </div>
    <p class="notif-status" role="status" hidden></p>
    <ul class="notif-list"></ul>
    <div class="notif-footer"><span class="notif-hint">Esc to close</span></div>
  `;
  document.body.append(element);
  element.showPopover();
  positionNotificationsMenu(element, trigger);
  trigger.setAttribute("aria-expanded", "true");

  const state = { element, trigger };
  state.onOutside = (event) => {
    if (!element.contains(event.target) && !trigger.contains(event.target)) closeOpenPullsMenu(false);
  };
  state.onKey = (event) => openPullsMenuKeys(event, element);
  state.onViewport = (event) => {
    if (!element.contains(event.target)) closeOpenPullsMenu(false);
  };
  document.addEventListener("pointerdown", state.onOutside, true);
  document.addEventListener("keydown", state.onKey, true);
  window.addEventListener("scroll", state.onViewport, true);
  window.addEventListener("resize", state.onViewport);
  state.timer = setInterval(() => updateMenuTime(element, accessToken ? openPulls.time : 0), MENU_TIME_REFRESH_MS);
  openPullsMenu = state;

  element.addEventListener("click", handleOpenPullsClick);
  renderOpenPulls();
  loadOpenPulls();
}

const pullsButton = document.querySelector("#pulls-button");
if (pullsButton) {
  pullsButton.addEventListener("click", () => {
    if (openPullsMenu) closeOpenPullsMenu();
    else openOpenPullsMenu(pullsButton);
  });
}
