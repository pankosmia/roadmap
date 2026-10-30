// "Notifications" menu: the GitHub notifications of the connected account, limited to the organization.
// It follows GitHub's inbox: a thread is unread until it is opened or marked as read, then stays listed
// (not highlighted) until it is marked as done with the check button.
// Loaded after open-pulls.js; it relies on globals declared in app.js (accessToken, issues, githubRequest, openPanel…).

const NOTIFICATION_PAGE_SIZE = 50;
const NOTIFICATION_MAX_PAGES = 6;
const NOTIFICATION_TTL = 45 * 1000;
const NOTIFICATION_OPEN_TTL = 15 * 1000;
// Done is only sent once the Undo snackbar (8 s, see showUndo) is gone.
const NOTIFICATION_UNDO_MS = 8000;
const NOTIFICATION_DONE_LIMIT = 300;
const NOTIFICATION_CACHE_KEY = "roadmap-notifications-cache";
const NOTIFICATION_DONE_KEY = "roadmap-notifications-done";
const NOTIFICATION_TOKEN_URL = "https://github.com/settings/tokens/new?scopes=public_repo,notifications&description=Pankosmia%20roadmap";

const NOTIFICATION_REASONS = {
  approval_requested: "Approval requested",
  assign: "Assigned",
  author: "Author",
  ci_activity: "CI activity",
  comment: "Comment",
  invitation: "Invitation",
  manual: "Subscribed",
  member_feature_requested: "Feature requested",
  mention: "Mentioned",
  review_requested: "Review requested",
  security_advisory_credit: "Security advisory",
  security_alert: "Security alert",
  state_change: "State changed",
  subscribed: "Watching",
  team_mention: "Team mentioned"
};

const NOTIFICATION_ICONS = {
  CheckSuite: "play_circle",
  Commit: "commit",
  Discussion: "forum",
  Issue: "adjust",
  PullRequest: "merge_type",
  Release: "sell"
};

function readNotificationsCache() {
  try {
    const cached = JSON.parse(sessionStorage.getItem(NOTIFICATION_CACHE_KEY));
    return cached && Array.isArray(cached.items) ? cached : null;
  } catch {
    return null;
  }
}

function saveNotificationsCache() {
  try {
    sessionStorage.setItem(NOTIFICATION_CACHE_KEY, JSON.stringify(notifications));
  } catch {
    // Storage may be unavailable or full; the list is then fetched again on each page view.
  }
}

// Threads marked as done, with the time of their last update: a done thread is hidden even if GitHub
// still lists it, until new activity makes it come back.
function readDoneThreads() {
  try {
    const saved = JSON.parse(localStorage.getItem(NOTIFICATION_DONE_KEY));
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  } catch {
    return {};
  }
}

function rememberDoneThread(id, updatedAt) {
  const done = readDoneThreads();
  delete done[id];
  done[id] = updatedAt;
  const ids = Object.keys(done);
  for (const old of ids.slice(0, Math.max(0, ids.length - NOTIFICATION_DONE_LIMIT))) delete done[old];
  try {
    localStorage.setItem(NOTIFICATION_DONE_KEY, JSON.stringify(done));
  } catch {
    // Storage may be unavailable; GitHub's own list is then the only source.
  }
}

function clearDoneThreads() {
  try {
    localStorage.removeItem(NOTIFICATION_DONE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

let notifications = readNotificationsCache() || { time: 0, items: [], truncated: false };
// A change (read, done, reconnect) bumps the run, so that a list fetched before it is dropped.
let notificationsRun = 0;
let notificationsLoadCount = 0;
let notificationsLoading = false;
let notificationsError = "";
// True when GitHub refuses the token (fine-grained tokens, or no `notifications` scope).
let notificationsDenied = false;
let notificationsMenu = null;
let notificationsTab = "unread";
const pendingDone = new Map();

function notificationFromThread(thread) {
  return {
    id: thread.id,
    unread: Boolean(thread.unread),
    reason: thread.reason,
    updatedAt: thread.updated_at,
    type: thread.subject.type,
    title: thread.subject.title,
    repo: thread.repository.full_name,
    apiUrl: thread.subject.url,
    commentUrl: thread.subject.latest_comment_url
  };
}

function notificationNumber(item) {
  return item.apiUrl?.match(/\/(?:issues|pulls)\/(\d+)$/)?.[1] || "";
}

// The thread only carries API URLs; this builds the page that GitHub itself would open.
function notificationUrl(item) {
  const repoUrl = `https://github.com/${item.repo}`;
  const path = item.apiUrl ? item.apiUrl.replace(`${API_ROOT}/repos/${item.repo}`, "") : "";
  const number = path.match(/^\/(issues|pulls)\/(\d+)$/);
  if (number) {
    const base = `${repoUrl}/${number[1] === "pulls" ? "pull" : "issues"}/${number[2]}`;
    const comment = item.commentUrl?.match(/\/(issues|pulls)\/comments\/(\d+)$/);
    if (!comment) return base;
    return comment[1] === "issues" ? `${base}#issuecomment-${comment[2]}` : `${base}#discussion_r${comment[2]}`;
  }
  const commit = path.match(/^\/commits\/(\w+)$/);
  if (commit) return `${repoUrl}/commit/${commit[1]}`;
  if (item.type === "Release") return `${repoUrl}/releases`;
  if (item.type === "Discussion") return `${repoUrl}/discussions`;
  if (item.type === "CheckSuite") return `${repoUrl}/actions`;
  return repoUrl;
}

function notificationAgeText(time) {
  const minutes = Math.floor((Date.now() - Date.parse(time)) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return days === 1 ? "1 day ago" : `${days} days ago`;
  return new Date(time).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

function visibleNotifications() {
  return notifications.items.filter((item) => !pendingDone.has(item.id));
}

function unreadNotificationCount() {
  return accessToken && !notificationsDenied ? visibleNotifications().filter((item) => item.unread).length : 0;
}

function updateNotificationsBadge() {
  const badge = document.querySelector("#notifications-badge");
  const button = document.querySelector("#notifications-button");
  if (!badge || !button) return;
  const count = unreadNotificationCount();
  badge.hidden = count === 0;
  badge.textContent = count > 99 ? "99+" : count;
  button.setAttribute("aria-label", count === 0 ? "Notifications" : `Notifications, ${count} unread`);
}

async function fetchNotifications(run) {
  const done = readDoneThreads();
  const items = [];
  let truncated = false;
  for (let page = 1; page <= NOTIFICATION_MAX_PAGES; page += 1) {
    // "no-cache" lets the browser revalidate with GitHub's ETag: an unchanged page answers 304, which is free.
    const threads = await githubRequest(
      `${API_ROOT}/notifications?all=true&per_page=${NOTIFICATION_PAGE_SIZE}&page=${page}`,
      { cache: "no-cache" },
      accessToken
    );
    if (run !== notificationsRun) return null;
    for (const thread of threads) {
      if (thread.repository.owner.login !== ORGANIZATION) continue;
      if (done[thread.id] && Date.parse(thread.updated_at) <= Date.parse(done[thread.id])) continue;
      items.push(notificationFromThread(thread));
    }
    if (threads.length < NOTIFICATION_PAGE_SIZE) break;
    truncated = page === NOTIFICATION_MAX_PAGES;
  }
  return { items, truncated };
}

async function loadNotifications({ force = false, maxAge = NOTIFICATION_TTL } = {}) {
  if (!accessToken || notificationsLoading) return;
  if (force) notificationsDenied = false;
  if (notificationsDenied) return;
  if (!force && Date.now() - notifications.time < maxAge) {
    renderNotifications();
    return;
  }
  const run = ++notificationsRun;
  const load = ++notificationsLoadCount;
  notificationsLoading = true;
  notificationsError = "";
  renderNotifications();
  try {
    const result = await fetchNotifications(run);
    if (result) {
      notifications = { time: Date.now(), ...result };
      saveNotificationsCache();
    }
  } catch (error) {
    if (run === notificationsRun) {
      // GitHub answers 403 (or 404) when the token cannot read notifications; retrying would fail the same way.
      if (!error.rateLimited && [401, 403, 404].includes(error.status)) notificationsDenied = true;
      else notificationsError = apiErrorMessage(error);
    }
  }
  if (load === notificationsLoadCount) notificationsLoading = false;
  renderNotifications();
}

function clearNotifications() {
  notificationsRun += 1;
  notificationsLoadCount += 1;
  notificationsLoading = false;
  notificationsError = "";
  notificationsDenied = false;
  notifications = { time: 0, items: [], truncated: false };
  for (const entry of pendingDone.values()) clearTimeout(entry.timer);
  pendingDone.clear();
  try {
    sessionStorage.removeItem(NOTIFICATION_CACHE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
  clearDoneThreads();
  closeNotificationsMenu(false);
  updateNotificationsBadge();
}

async function markNotificationRead(item) {
  if (!item.unread) return;
  item.unread = false;
  notificationsRun += 1;
  saveNotificationsCache();
  renderNotifications();
  try {
    await githubRequest(`${API_ROOT}/notifications/threads/${item.id}`, { method: "PATCH" }, accessToken);
  } catch (error) {
    item.unread = true;
    saveNotificationsCache();
    renderNotifications();
    showNotice(`Could not mark the notification as read: ${apiErrorMessage(error)}`, true);
  }
}

// GitHub's "mark everything as read" call would also touch other organizations, so it is sent per repository.
async function markAllNotificationsRead() {
  const targets = visibleNotifications().filter((item) => item.unread);
  if (targets.length === 0) return;
  const readAt = new Date().toISOString();
  const byRepo = new Map();
  for (const item of targets) {
    item.unread = false;
    byRepo.set(item.repo, [...(byRepo.get(item.repo) || []), item]);
  }
  notificationsRun += 1;
  saveNotificationsCache();
  renderNotifications();
  const repos = [...byRepo.keys()];
  const results = await Promise.allSettled(
    repos.map((repo) =>
      githubRequest(
        `${API_ROOT}/repos/${repo}/notifications`,
        { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ last_read_at: readAt, read: true }) },
        accessToken
      )
    )
  );
  const failed = results.map((result, index) => (result.status === "rejected" ? index : -1)).filter((index) => index >= 0);
  if (failed.length === 0) return;
  for (const index of failed) for (const item of byRepo.get(repos[index])) item.unread = true;
  saveNotificationsCache();
  renderNotifications();
  showNotice(`Could not mark all notifications as read: ${apiErrorMessage(results[failed[0]].reason)}`, true);
}

async function commitNotificationDone(entry, keepalive = false) {
  clearTimeout(entry.timer);
  const { item, token } = entry;
  try {
    await githubRequest(`${API_ROOT}/notifications/threads/${item.id}`, { method: "DELETE", keepalive }, token);
    if (token === accessToken) {
      rememberDoneThread(item.id, item.updatedAt);
      notifications.items = notifications.items.filter((other) => other.id !== item.id);
      saveNotificationsCache();
    }
  } catch (error) {
    if (token === accessToken) showNotice(`Could not mark the notification as done: ${apiErrorMessage(error)}`, true);
  } finally {
    if (pendingDone.get(item.id) === entry) pendingDone.delete(item.id);
    renderNotifications();
  }
}

// Done cannot be undone through GitHub's API, so the row is hidden at once and the request waits for the Undo delay.
function doneNotification(item) {
  for (const earlier of [...pendingDone.values()]) commitNotificationDone(earlier);
  const entry = { item, token: accessToken, timer: 0 };
  pendingDone.set(item.id, entry);
  notificationsRun += 1;
  renderNotifications();
  showUndo("Notification marked as done", () => {
    clearTimeout(entry.timer);
    pendingDone.delete(item.id);
    renderNotifications();
  });
  entry.timer = setTimeout(() => commitNotificationDone(entry), NOTIFICATION_UNDO_MS);
}

function openNotification(item) {
  markNotificationRead(item);
  closeNotificationsMenu(false);
  const issue = item.type === "Issue" ? issues.find((candidate) => candidate.url === item.apiUrl) : null;
  if (issue) openPanel(issue);
  else window.open(notificationUrl(item), "_blank", "noopener");
}

function notificationRowHtml(item) {
  const number = notificationNumber(item);
  const reason = NOTIFICATION_REASONS[item.reason] || item.reason.replaceAll("_", " ");
  const ref = `${escapeHtml(displayRepo(item.repo))}${number ? `#${number}` : ""}`;
  const unreadMark = item.unread ? '<span class="notif-dot" role="img" aria-label="Unread"></span>' : '<span class="notif-dot" aria-hidden="true"></span>';
  const readButton = item.unread
    ? '<md-icon-button class="notif-read" aria-label="Mark as read" title="Mark as read"><md-icon>mark_email_read</md-icon></md-icon-button>'
    : "";
  return `
    <li class="notif-row${item.unread ? " unread" : ""}" data-id="${escapeHtml(item.id)}">
      <button type="button" class="notif-open">
        ${unreadMark}
        <md-icon class="notif-type">${NOTIFICATION_ICONS[item.type] || "notifications"}</md-icon>
        <span class="notif-text">
          <span class="notif-title">${escapeHtml(item.title)}</span>
          <span class="notif-meta">${ref} · ${escapeHtml(reason)} · ${notificationAgeText(item.updatedAt)}</span>
        </span>
      </button>
      ${readButton}
      <md-icon-button class="notif-done" aria-label="Mark as done" title="Mark as done"><md-icon>check</md-icon></md-icon-button>
    </li>`;
}

function notificationsMessageHtml(icon, text, extra = "") {
  return `<li class="notif-empty"><md-icon>${icon}</md-icon><p>${text}</p>${extra}</li>`;
}

function renderNotifications() {
  updateNotificationsBadge();
  if (!notificationsMenu) return;
  const { element } = notificationsMenu;
  const list = element.querySelector(".notif-list");
  const status = element.querySelector(".notif-status");
  const items = accessToken && !notificationsDenied ? visibleNotifications() : [];
  const unread = items.filter((item) => item.unread);
  const shown = notificationsTab === "unread" ? unread : items;

  element.querySelector('[data-tab="unread"]').textContent = `Unread (${unread.length})`;
  element.querySelector('[data-tab="all"]').textContent = `All (${items.length})`;
  for (const tab of element.querySelectorAll(".notif-tab")) {
    const selected = tab.dataset.tab === notificationsTab;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  element.querySelector(".notif-mark-all").disabled = unread.length === 0;
  element.querySelector(".notif-refresh").disabled = notificationsLoading || !accessToken || notificationsDenied;

  const scrollTop = list.scrollTop;
  const focusedId = list.contains(document.activeElement) ? document.activeElement.closest(".notif-row")?.dataset.id : null;
  const focusedIndex = focusedId ? [...list.children].findIndex((row) => row.dataset.id === focusedId) : -1;
  let statusText = "";
  if (!accessToken) {
    list.innerHTML = notificationsMessageHtml("notifications_off", "Connect GitHub to see the notifications of your account.", '<md-text-button class="notif-connect" type="button">Connect GitHub</md-text-button>');
  } else if (notificationsDenied) {
    list.innerHTML = notificationsMessageHtml(
      "key_off",
      "GitHub only gives notifications to a classic token with the <b>notifications</b> scope; fine-grained tokens cannot read them.",
      `<a class="notif-token-link" href="${NOTIFICATION_TOKEN_URL}" target="_blank" rel="noopener">Create a classic token</a>`
    );
  } else if (notificationsLoading && notifications.time === 0) {
    list.innerHTML = '<li class="notif-empty"><md-circular-progress indeterminate aria-label="Loading"></md-circular-progress></li>';
  } else if (notificationsError && notifications.time === 0) {
    list.innerHTML = notificationsMessageHtml("error", `Notifications could not be loaded: ${escapeHtml(notificationsError)}`, '<md-text-button class="notif-retry" type="button">Retry</md-text-button>');
  } else if (shown.length === 0) {
    list.innerHTML =
      notificationsTab === "unread"
        ? notificationsMessageHtml("task_alt", "You're all caught up.")
        : notificationsMessageHtml("notifications", "No notification in the organization.");
  } else {
    list.innerHTML = shown.map(notificationRowHtml).join("");
  }
  if (notificationsError && notifications.time > 0) statusText = `Could not refresh (${notificationsError}). Showing the last loaded list.`;
  else if (notificationsLoading && notifications.time > 0) statusText = "Refreshing…";
  else if (notifications.truncated) statusText = `Showing the ${NOTIFICATION_PAGE_SIZE * NOTIFICATION_MAX_PAGES} most recent notifications.`;
  status.textContent = statusText;
  status.hidden = statusText === "";

  list.scrollTop = scrollTop;
  // After an action the focused row is gone or has changed: keep the keyboard where it was.
  if (focusedIndex >= 0 && !list.contains(document.activeElement)) {
    const targets = list.querySelectorAll(".notif-open");
    (targets[Math.min(focusedIndex, targets.length - 1)] || element.querySelector(".notif-tab[aria-selected='true']")).focus();
  }
}

function positionNotificationsMenu(element, trigger) {
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(420, window.innerWidth - 16);
  const below = window.innerHeight - rect.bottom - 12;
  const above = rect.top - 12;
  const openAbove = below < 240 && above > below;
  element.style.width = `${width}px`;
  element.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  element.style.top = openAbove ? "auto" : `${rect.bottom + 4}px`;
  element.style.bottom = openAbove ? `${window.innerHeight - rect.top + 4}px` : "auto";
  element.style.maxHeight = `${Math.min(560, openAbove ? above : below)}px`;
}

function closeNotificationsMenu(restoreFocus = true) {
  if (!notificationsMenu) return;
  const { element, trigger, onOutside, onKey, onViewport } = notificationsMenu;
  document.removeEventListener("pointerdown", onOutside, true);
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("scroll", onViewport, true);
  window.removeEventListener("resize", onViewport);
  element.remove();
  notificationsMenu = null;
  trigger.setAttribute("aria-expanded", "false");
  if (restoreFocus) trigger.focus();
}

function notificationsMenuKeys(event, element) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeNotificationsMenu();
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

function openNotificationsMenu(trigger) {
  closeNotificationsMenu(false);
  const element = document.createElement("div");
  element.className = "notif-menu";
  element.setAttribute("popover", "manual");
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-label", "Notifications");
  element.innerHTML = `
    <div class="notif-header">
      <h4>Notifications</h4>
      <md-icon-button class="notif-mark-all" aria-label="Mark all as read" title="Mark all as read"><md-icon>done_all</md-icon></md-icon-button>
      <md-icon-button class="notif-refresh" aria-label="Refresh notifications" title="Refresh"><md-icon>refresh</md-icon></md-icon-button>
    </div>
    <div class="notif-tabs" role="tablist" aria-label="Notification filter">
      <button type="button" class="notif-tab" role="tab" data-tab="unread"></button>
      <button type="button" class="notif-tab" role="tab" data-tab="all"></button>
    </div>
    <p class="notif-status" role="status" hidden></p>
    <ul class="notif-list"></ul>
    <div class="notif-footer"><a href="https://github.com/notifications" target="_blank" rel="noopener">Open all on GitHub<md-icon>open_in_new</md-icon></a></div>
  `;
  document.body.append(element);
  element.showPopover();
  positionNotificationsMenu(element, trigger);
  trigger.setAttribute("aria-expanded", "true");

  const state = { element, trigger };
  state.onOutside = (event) => {
    if (!element.contains(event.target) && !trigger.contains(event.target)) closeNotificationsMenu(false);
  };
  state.onKey = (event) => notificationsMenuKeys(event, element);
  state.onViewport = (event) => {
    if (!element.contains(event.target)) closeNotificationsMenu(false);
  };
  document.addEventListener("pointerdown", state.onOutside, true);
  document.addEventListener("keydown", state.onKey, true);
  window.addEventListener("scroll", state.onViewport, true);
  window.addEventListener("resize", state.onViewport);
  notificationsMenu = state;

  element.addEventListener("click", handleNotificationsClick);
  notificationsTab = unreadNotificationCount() > 0 || !accessToken ? "unread" : "all";
  renderNotifications();
  loadNotifications({ maxAge: NOTIFICATION_OPEN_TTL });
}

function handleNotificationsClick(event) {
  const target = event.target;
  const row = target.closest(".notif-row");
  const item = row ? notifications.items.find((candidate) => candidate.id === row.dataset.id) : null;
  const tab = target.closest(".notif-tab");
  if (tab) {
    notificationsTab = tab.dataset.tab;
    renderNotifications();
  } else if (target.closest(".notif-mark-all")) markAllNotificationsRead();
  else if (target.closest(".notif-refresh")) loadNotifications({ force: true });
  else if (target.closest(".notif-retry")) loadNotifications({ force: true });
  else if (target.closest(".notif-connect")) {
    closeNotificationsMenu(false);
    openAuthDialog();
  } else if (item && target.closest(".notif-done")) doneNotification(item);
  else if (item && target.closest(".notif-read")) markNotificationRead(item);
  else if (item && target.closest(".notif-open")) openNotification(item);
}

const notificationsButton = document.querySelector("#notifications-button");
if (notificationsButton) {
  notificationsButton.addEventListener("click", () => {
    if (notificationsMenu) closeNotificationsMenu();
    else openNotificationsMenu(notificationsButton);
  });
}

// Pages are left before a pending Done has waited for its Undo delay: send it now.
window.addEventListener("pagehide", () => {
  for (const entry of pendingDone.values()) commitNotificationDone(entry, true);
});
