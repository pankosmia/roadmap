// Live sync: keeps the board in step with what teammates change on GitHub, without a manual Refresh.
// Every minute the tab is visible, one search request asks for the issues updated since the last check and merges
// them by id. A full reconcile every 10 minutes catches what a delta cannot see (deleted or transferred issues,
// changes that do not bump "updated"). Loaded before app.js; it relies on globals declared in app.js and the other files.

const SYNC_INTERVAL = 60 * 1000;
const SYNC_INTERVAL_ANONYMOUS = 120 * 1000;
// The search index lags a little behind GitHub, so each check also covers the end of the previous one.
const SYNC_OVERLAP = 2 * 60 * 1000;
const SYNC_RECONCILE_INTERVAL = 10 * 60 * 1000;
const SYNC_MAX_BACKOFF = 5 * 60 * 1000;
const SYNC_MAX_DELTA_PAGES = 3;
// Coming back to the tab checks at once, unless the last check was this recent.
const SYNC_RESUME_GAP = 15 * 1000;
const SYNC_RENDER_RETRY = 1500;
const SYNC_HIGHLIGHT_MS = 6000;
const SYNC_TOAST_MS = 5000;
const SYNC_MAX_PULL_REFRESH = 200;

// The moment up to which the loaded issues are known to be current. It is saved with the issues cache,
// so a page opened from the cache asks GitHub only for what changed since then.
let issuesFetchedAt = 0;

const liveSync = {
  started: false,
  running: false,
  timer: 0,
  renderTimer: 0,
  toastTimer: 0,
  highlightTimer: 0,
  lastPollAt: 0,
  lastReconcileAt: 0,
  failures: 0,
  pausedUntil: 0,
  pending: []
};

// A full load of the issues is a reconcile too.
function markFullSync(startedAt) {
  issuesFetchedAt = startedAt;
  liveSync.lastReconcileAt = startedAt;
  liveSync.failures = 0;
}

function syncInterval() {
  const base = accessToken ? SYNC_INTERVAL : SYNC_INTERVAL_ANONYMOUS;
  const backedOff = liveSync.failures > 0 ? Math.min(SYNC_MAX_BACKOFF, base * 2 ** liveSync.failures) : base;
  return Math.max(backedOff, liveSync.pausedUntil - Date.now());
}

function scheduleSync(delay = syncInterval()) {
  clearTimeout(liveSync.timer);
  if (document.hidden) return;
  // A little jitter keeps a team that opened the board together from polling in lockstep.
  const jitter = delay * 0.1 * (Math.random() * 2 - 1);
  liveSync.timer = setTimeout(runSync, Math.max(1000, delay + jitter));
}

function setSyncStatus(problem = "") {
  const checked = new Date(liveSync.lastPollAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  refreshButton.title = problem ? `Live updates paused: ${problem}` : `Live updates on. Last checked at ${checked}.`;
}

async function runSync() {
  clearTimeout(liveSync.timer);
  if (document.hidden) return;
  if (liveSync.running || isLoading || loadFailed || issuesFetchedAt === 0) {
    scheduleSync(5000);
    return;
  }
  liveSync.running = true;
  const startedAt = Date.now();
  liveSync.lastPollAt = startedAt;
  try {
    if (startedAt - liveSync.lastReconcileAt >= SYNC_RECONCILE_INTERVAL) await reconcileIssues(startedAt);
    else await pollIssueChanges(startedAt);
    liveSync.failures = 0;
    liveSync.pausedUntil = 0;
    setSyncStatus();
    // Refreshes only when its own 5-minute cache is stale.
    loadOpenPulls();
  } catch (error) {
    liveSync.failures += 1;
    if (error.rateLimited && error.retryAt) liveSync.pausedUntil = error.retryAt;
    setSyncStatus(apiErrorMessage(error));
  } finally {
    liveSync.running = false;
    scheduleSync();
  }
}

function syncTimestamp(time) {
  return new Date(Math.max(0, time)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function pollIssueChanges(startedAt) {
  const query = `updated:>=${syncTimestamp(issuesFetchedAt - SYNC_OVERLAP)}`;
  const first = await searchPage(query, 1, PAGE_SIZE, { cache: "no-cache" });
  // After a long absence the delta is as large as a full load.
  if (first.total_count > SYNC_MAX_DELTA_PAGES * PAGE_SIZE) {
    await reconcileIssues(startedAt);
    return;
  }
  const items = [...first.items];
  const pages = Math.ceil(first.total_count / PAGE_SIZE);
  for (let page = 2; page <= pages; page += 1) {
    items.push(...(await searchPage(query, page, PAGE_SIZE, { cache: "no-cache" })).items);
  }
  issuesFetchedAt = startedAt;
  queueRemoteIssues(items, false, startedAt);
}

async function reconcileIssues(startedAt) {
  const { items: openIssues, totalCount } = await searchAllIssues("is:open", { quiet: true });
  const closedIssues = (await searchAllIssues(closedBoardQuery(), { quiet: true })).items;
  markFullSync(startedAt);
  // Search lists at most 1,000 issues, so a longer list cannot tell which issues are gone.
  queueRemoteIssues([...openIssues, ...closedIssues], totalCount <= 1000, startedAt);
  preloadSubIssueOrders();
}

// What the board cannot be rebuilt under: a card or a subissue being dragged, an open pull request popover
// or a field being typed in. The changes wait, and are applied together once it is over.
function syncBusy() {
  if (dragState || developmentPopover) return true;
  const active = document.activeElement;
  return Boolean(active && board.contains(active) && active.closest("input, textarea, md-outlined-text-field, md-filled-text-field"));
}

function queueRemoteIssues(items, snapshot, startedAt) {
  liveSync.pending.push({ items, snapshot, startedAt });
  flushRemoteIssues();
}

function flushRemoteIssues() {
  clearTimeout(liveSync.renderTimer);
  if (liveSync.pending.length === 0) return;
  if (syncBusy()) {
    liveSync.renderTimer = setTimeout(flushRemoteIssues, SYNC_RENDER_RETRY);
    return;
  }
  applyRemoteBatches(liveSync.pending.splice(0));
}

function belongsInSnapshot(issue) {
  if (!isClosed(issue)) return true;
  return DONE_VERSIONS.includes(issueVersion(issue)) && Date.parse(issue.closed_at) >= Date.now() - ARCHIVE_AFTER_MS;
}

function hasPendingSave(issueId) {
  const save = issueSaves.get(issueId);
  return Boolean(save && (save.running || save.timer !== null || Object.keys(save.body).length > 0));
}

// Merges a batch into the loaded issues and records { before, after } for each issue that changed on GitHub.
// An issue GitHub reports with an older "updated" time than ours is skipped: it is our own change, not yet indexed.
function mergeRemoteBatch({ items, snapshot, startedAt }, changes) {
  const known = new Map(issues.map((issue) => [issue.id, issue]));
  const seen = new Set();
  for (const item of items) {
    seen.add(item.id);
    const local = known.get(item.id);
    if (!local) {
      if (!belongsInSnapshot(item) && !archive.sources) continue;
      issues.push(item);
      known.set(item.id, item);
      noteArchiveChange(item);
      changes.push({ before: null, after: item });
      continue;
    }
    if (hasPendingSave(local.id) || Date.parse(item.updated_at) <= Date.parse(local.updated_at)) continue;
    const merged = mergeUpdatedIssue(local, item);
    known.set(item.id, merged);
    changes.push({ before: local, after: merged });
  }
  if (!snapshot) return;

  // A full snapshot also tells which issues are gone. Recent local issues may not be indexed yet.
  const keptIds = new Set(archive.ids);
  const recent = startedAt - SYNC_OVERLAP;
  const removed = issues.filter(
    (issue) =>
      !seen.has(issue.id) &&
      !keptIds.has(issue.id) &&
      issue.id !== panelIssueId &&
      !hasPendingSave(issue.id) &&
      Date.parse(issue.updated_at) < recent
  );
  if (removed.length === 0) return;
  const removedIds = new Set(removed.map((issue) => issue.id));
  issues = issues.filter((issue) => !removedIds.has(issue.id));
  for (const issue of removed) changes.push({ before: issue, after: null });
}

function applyRemoteBatches(batches) {
  const panelState = capturePanelState();
  const changes = [];
  for (const batch of batches) mergeRemoteBatch(batch, changes);
  if (changes.length === 0) return;

  saveIssuesCache();
  renderBoardKeepingPosition();
  summary.textContent = summaryText();
  syncOpenPanel(panelState, changes);
  refreshChangedOrders(changes);
  refreshChangedPulls(changes);
  const changedIds = changes.filter((change) => change.after).map((change) => change.after.id);
  highlightUpdated(changedIds);
  showSyncToast(changes.length);
}

function renderBoardKeepingPosition() {
  const lists = new Map([...board.querySelectorAll(".issue-list")].map((list) => [list.dataset.dropVersion, list.scrollTop]));
  const { scrollX, scrollY } = window;
  const boardLeft = board.scrollLeft;
  renderBoard();
  board.scrollLeft = boardLeft;
  for (const list of board.querySelectorAll(".issue-list")) list.scrollTop = lists.get(list.dataset.dropVersion) || 0;
  window.scrollTo(scrollX, scrollY);
}

function capturePanelState() {
  if (panelIssueId === null || panelIssueId === DRAFT_ID || !panelElements) return null;
  const issue = currentIssue();
  if (!issue) return null;
  return { id: issue.id, title: issue.title, body: issue.body || "", dirty: hasUnsavedChanges() };
}

// The open panel follows the issue. The title and the description are only replaced when nothing was typed in them.
function syncOpenPanel(state, changes) {
  if (!state || panelIssueId !== state.id || !changes.some((change) => change.after?.id === state.id)) return;
  const issue = currentIssue();
  if (!issue) return;
  if (issue.title !== state.title || (issue.body || "") !== state.body) {
    if (state.dirty) {
      showPanelError("Someone else changed this issue on GitHub. Your unsaved edits are kept, and saving will replace their version.");
    } else {
      panelElements.title.value = issue.title;
      descriptionEditor.value = issue.body || "";
    }
  }
  // Makes the panel load the relationships and the development of the issue again.
  panelExtras.key = "";
  refreshPanel();
}

function rootIssue(issue) {
  const seen = new Set();
  let current = issue;
  while (current.parent_issue_url && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = issues.find((item) => item.url === current.parent_issue_url);
    if (!parent) break;
    current = parent;
  }
  return current;
}

// Lists of subissues are fetched again when a parent changed or when an issue gained or lost subissues.
function refreshChangedOrders(changes) {
  const parentUrls = new Set();
  for (const { before, after } of changes) {
    const oldUrl = before?.parent_issue_url || null;
    const newUrl = after?.parent_issue_url || null;
    if (oldUrl !== newUrl) {
      if (oldUrl) parentUrls.add(oldUrl);
      if (newUrl) parentUrls.add(newUrl);
    }
    if ((before?.sub_issues_summary?.total || 0) !== (after?.sub_issues_summary?.total || 0)) parentUrls.add((after || before).url);
  }
  const roots = new Map();
  for (const url of parentUrls) {
    const parent = issues.find((item) => item.url === url);
    if (!parent) continue;
    forgetOrders(url);
    const root = rootIssue(parent);
    roots.set(root.id, root);
  }
  for (const root of roots.values()) {
    if (accessToken) loadSubIssueOrders(liveIssue(root), { quiet: true });
    else refreshSubissueSections(root.id);
  }
}

// Linked pull requests are fetched again for the issues that changed (GitHub needs a token for this).
async function refreshChangedPulls(changes) {
  if (!accessToken) return;
  const targets = changes
    .map((change) => change.after && issues.find((issue) => issue.id === change.after.id))
    .filter(Boolean)
    .slice(0, SYNC_MAX_PULL_REFRESH);
  try {
    for (let start = 0; start < targets.length; start += PULL_BATCH_SIZE) {
      await loadPullBatch(targets.slice(start, start + PULL_BATCH_SIZE));
    }
  } catch {
    // The icons keep what is known; the next full load fetches them again.
  }
  if (targets.length > 0) {
    refreshDevelopmentIcons();
    saveIssuesCache();
  }
}

function highlightUpdated(ids) {
  for (const id of ids) {
    for (const element of board.querySelectorAll(`.issue-card[data-issue-id="${id}"], .subissue-node[data-issue-id="${id}"]`)) {
      element.classList.add("remote-updated");
    }
  }
  clearTimeout(liveSync.highlightTimer);
  liveSync.highlightTimer = setTimeout(() => {
    for (const element of board.querySelectorAll(".remote-updated")) element.classList.remove("remote-updated");
  }, SYNC_HIGHLIGHT_MS);
}

function showSyncToast(count) {
  clearTimeout(liveSync.toastTimer);
  document.querySelector(".sync-snackbar")?.remove();
  const toast = document.createElement("div");
  toast.className = "snackbar sync-snackbar";
  toast.setAttribute("role", "status");
  toast.textContent = `${count} ${count === 1 ? "issue" : "issues"} updated from GitHub.`;
  document.body.append(toast);
  liveSync.toastTimer = setTimeout(() => toast.remove(), SYNC_TOAST_MS);
}

function checkNow() {
  if (!liveSync.started || document.hidden || liveSync.running) return;
  if (Date.now() - liveSync.lastPollAt < SYNC_RESUME_GAP || Date.now() < liveSync.pausedUntil) return;
  runSync();
}

function startLiveSync() {
  if (liveSync.started || (document.body.dataset.page === "detail" && !detailVersion)) return;
  liveSync.started = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(liveSync.timer);
    else checkNow();
  });
  window.addEventListener("focus", checkNow);
  window.addEventListener("online", checkNow);
  // Issues opened from a recent cache may already be out of date.
  scheduleSync(Date.now() - issuesFetchedAt > 30000 ? 2000 : syncInterval());
}

// Conflict-safe writes. A teammate may have changed labels or assignees since the board last synced, and a PATCH
// sends the whole list. Keeping only what this user added or removed, on top of what GitHub has now, avoids
// silently undoing the teammate's change.
function rebaseList(base, desired, remote) {
  const removed = base.filter((value) => !desired.includes(value));
  const added = desired.filter((value) => !base.includes(value));
  return [...remote.filter((value) => !removed.includes(value)), ...added.filter((value) => !remote.includes(value))];
}

// Returns the issue as GitHub has it now, or null when it cannot be read.
async function readRemoteIssue(issue) {
  try {
    return await githubRequest(issueEndpoint(issue), { cache: "no-cache" }, accessToken);
  } catch {
    return null;
  }
}

// Falls back to the desired labels when the issue cannot be read, which is what a plain PATCH would have sent.
async function rebaseLabels(issue, baseLabels, desiredNames) {
  const remote = await readRemoteIssue(issue);
  if (!remote) return desiredNames;
  return rebaseList(baseLabels.map((label) => label.name), desiredNames, remote.labels.map((label) => label.name));
}
