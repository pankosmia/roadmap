const ORGANIZATION = "pankosmia";
const API_ROOT = "https://api.github.com";
const DEFAULT_REPOSITORY = "roadmap";
const PAGE_SIZE = 100;
const VERSIONS = ["Unassigned", "Backlog", "Next", "Current"];
const VERSION_LABELS = new Map(VERSIONS.map((version) => [version, `Version : ${version}`]));

const FLOWS = ["No Spec", "UI Design", "Spec'ing", "Spec'd", "Implement Now", "Implementing", "Reviewing", "Done"];
const BACKLOG_FLOWS = FLOWS.slice(0, 4);
const DEFAULT_FLOW = "No Spec";
const DETAIL_VERSIONS = ["Backlog", "Next", "Current"];
const requestedVersion = new URLSearchParams(window.location.search).get("version");
const detailVersion = document.body.dataset.page === "detail" && DETAIL_VERSIONS.includes(requestedVersion) ? requestedVersion : "";
const COLUMNS = detailVersion ? (detailVersion === "Backlog" ? BACKLOG_FLOWS : FLOWS) : VERSIONS;

const board = document.querySelector("#board");
const summary = document.querySelector("#board-summary");
const notice = document.querySelector("#notice");
const refreshButton = document.querySelector("#refresh-button");
const authButton = document.querySelector("#auth-button");
const authStatus = document.querySelector("#auth-status");
const authDialog = document.querySelector("#auth-dialog");
const authForm = document.querySelector("#auth-form");
const tokenInput = document.querySelector("#token-input");
const authError = document.querySelector("#auth-error");
const cancelAuth = document.querySelector("#cancel-auth");
const submitAuth = document.querySelector("#submit-auth");
const rememberInput = document.querySelector("#remember-input");
const addButton = document.querySelector("#add-button");
const LOADING_HTML = '<div class="loading-state"><md-circular-progress indeterminate aria-label="Loading"></md-circular-progress><span>Loading Pankosmia issues…</span></div>';

let accessToken = "";
let currentLogin = "";
let issues = [];
let loadFailed = false;
let isLoading = false;
let searchTerm = "";
let undoTimer = 0;
const COLLAPSED_KEY = `roadmap-collapsed-${detailVersion || "main"}`;
const collapsedColumns = new Set(loadCollapsedColumns());

function loadCollapsedColumns() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLLAPSED_KEY));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function saveCollapsedColumns() {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsedColumns]));
  } catch {
    // Storage may be unavailable; the collapsed state then lasts only for this page view.
  }
}
const TOKEN_KEY = "roadmap-token";
const searchInput = document.querySelector("#search-input");

function storeToken(token, remember) {
  clearStoredToken();
  try {
    (remember ? localStorage : sessionStorage).setItem(TOKEN_KEY, token);
  } catch {
    // Storage may be unavailable; the token then lasts only for this page view.
  }
}

function readStoredToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

function clearStoredToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

function requestHeaders(token = "") {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28"
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function githubRequest(url, options = {}, token = "") {
  const response = await fetch(url, {
    ...options,
    headers: { ...requestHeaders(token), ...options.headers }
  });
  if (!response.ok) {
    let message = `GitHub returned ${response.status}.`;
    try {
      const body = await response.json();
      if (body.message) message = body.message;
    } catch {
      // Keep the HTTP status message when the response has no JSON body.
    }
    const failure = new Error(message);
    failure.status = response.status;
    failure.authenticated = Boolean(token);
    failure.rateLimited =
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(message)));
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const retryAfter = Number(response.headers.get("retry-after"));
    if (retryAfter > 0) failure.retryAt = Date.now() + retryAfter * 1000;
    else if (reset > 0) failure.retryAt = reset * 1000;
    throw failure;
  }
  return response.status === 204 ? null : response.json();
}

function apiErrorMessage(error) {
  if (!error.rateLimited) return error.message;
  const when = error.retryAt
    ? ` Try again at ${new Date(error.retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`
    : " Try again later.";
  return error.authenticated
    ? `GitHub's API limit for your token has been reached.${when}`
    : `GitHub's unauthenticated API limit has been reached. Connect a token to raise it.${when}`;
}

const ISSUES_CACHE_KEY = "roadmap-issues-cache";
const ISSUES_CACHE_TTL = 5 * 60 * 1000;

function readIssuesCache() {
  try {
    const cached = JSON.parse(sessionStorage.getItem(ISSUES_CACHE_KEY));
    return cached && Array.isArray(cached.issues) ? cached : null;
  } catch {
    return null;
  }
}

function saveIssuesCache() {
  try {
    sessionStorage.setItem(ISSUES_CACHE_KEY, JSON.stringify({ time: Date.now(), issues }));
  } catch {
    // Storage may be unavailable or full; the board then reloads on each page view.
  }
}

function clearIssuesCache() {
  try {
    sessionStorage.removeItem(ISSUES_CACHE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

async function loadIssues({ force = false } = {}) {
  if (isLoading || (document.body.dataset.page === "detail" && !detailVersion)) return;
  isLoading = true;
  refreshButton.disabled = true;
  notice.hidden = true;

  // Show cached issues at once; only refetch when they are stale or a refresh is forced.
  const cached = force ? null : readIssuesCache();
  if (cached) {
    issues = cached.issues;
    await loadColumnLabelColors();
    renderBoard();
    refreshPanel();
    summary.textContent = summaryText();
    if (Date.now() - cached.time < ISSUES_CACHE_TTL) {
      isLoading = false;
      refreshButton.disabled = false;
      loadPullRequests();
      return;
    }
  } else {
    board.innerHTML = LOADING_HTML;
    summary.textContent = "Loading issues…";
  }

  try {
    const { items: openIssues, totalCount } = await searchAllIssues("is:open");
    let closedIssues = [];
    try {
      closedIssues = (await searchAllIssues("is:closed")).items;
    } catch (error) {
      if (!cached) showNotice(`Closed issues could not be loaded: ${apiErrorMessage(error)}`, true);
    }
    const results = [...openIssues, ...closedIssues];

    // Keep the known pull requests on screen while they are refreshed.
    const previousPulls = new Map(issues.filter((issue) => issue.pulls).map((issue) => [issue.id, issue.pulls]));
    for (const issue of results) {
      if (previousPulls.has(issue.id)) issue.pulls = previousPulls.get(issue.id);
    }
    issues = results;
    saveIssuesCache();
    loadFailed = false;
    await loadColumnLabelColors();
    renderBoard();
    refreshPanel();
    summary.textContent = summaryText();
    loadPullRequests({ force: true });
    if (totalCount > 1000) {
      showNotice(`GitHub search can return at most 1,000 results. Showing the first 1,000 of ${totalCount} issues.`);
    } else {
      const inconsistentIssues = issues.filter(
        (issue) => !isClosed(issue) && issue.labels.filter((label) => isVersionLabel(label.name)).length > 1
      ).length;
      if (inconsistentIssues > 0) {
        showNotice(
          `${inconsistentIssues} issue${inconsistentIssues === 1 ? " has" : "s have"} multiple Version labels. Moving an issue replaces all its Version labels with one.`
        );
      }
    }
  } catch (error) {
    if (!cached) {
      loadFailed = true;
      board.innerHTML = '<div class="empty-state"><md-icon>cloud_off</md-icon><span>Could not load issues from GitHub.</span></div>';
      summary.textContent = "Issues could not be loaded";
    }
    showNotice(apiErrorMessage(error), true);
  } finally {
    isLoading = false;
    refreshButton.disabled = false;
  }
}

async function searchAllIssues(state) {
  const query = encodeURIComponent(`org:${ORGANIZATION} is:issue ${state} sort:updated-desc`);
  const firstPage = await githubRequest(`${API_ROOT}/search/issues?q=${query}&per_page=${PAGE_SIZE}&page=1`, {}, accessToken);
  const totalCount = firstPage.total_count;
  const pages = Math.ceil(Math.min(totalCount, 1000) / PAGE_SIZE);
  const items = [...firstPage.items];
  for (let page = 2; page <= pages; page += 1) {
    summary.textContent = `Loading issues… ${Math.min(items.length, totalCount)} of ${totalCount}`;
    const result = await githubRequest(`${API_ROOT}/search/issues?q=${query}&per_page=${PAGE_SIZE}&page=${page}`, {}, accessToken);
    items.push(...result.items);
  }
  return { items, totalCount };
}

function summaryText() {
  const boardIssues = issues.filter(isOnBoard);
  const scoped = detailVersion ? boardIssues.filter((issue) => issueVersion(issue) === detailVersion) : boardIssues;
  const count = scoped.length;
  const scope = detailVersion ? ` in ${detailVersion}` : "";
  if (hasActiveFilters()) return `${scoped.filter(passesFilters).length} of ${count} issues${scope}`;
  return `${count} ${count === 1 ? "issue" : "issues"}${scope}`;
}

function isVersionLabel(labelName) {
  return /^Version\s*:/i.test(labelName);
}

function flowLabelName(flow) {
  return `Flow : ${flow}`;
}

function isFlowLabel(labelName) {
  return /^Flow\s*:/i.test(labelName);
}

function issueFlow(issue) {
  for (const flow of FLOWS) {
    if (issue.labels.some((label) => label.name === flowLabelName(flow))) return flow;
  }
  return DEFAULT_FLOW;
}

function issueColumn(issue) {
  return detailVersion ? issueFlow(issue) : issueVersion(issue);
}

function issueVersion(issue) {
  for (const version of VERSIONS) {
    if (issue.labels.some((label) => label.name === VERSION_LABELS.get(version))) return version;
  }
  return "Unassigned";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function subIssuesOf(parent) {
  return issues.filter((issue) => issue.parent_issue_url === parent.url);
}

function isNestedSubIssue(issue) {
  return Boolean(issue.parent_issue_url) && issues.some((item) => item.url === issue.parent_issue_url);
}

function matchesText(issue) {
  return `${issue.title} ${issue.body || ""}`.toLowerCase().includes(searchTerm);
}

function matchesSearch(issue) {
  if (!searchTerm) return true;
  return matchesText(issue) || subIssuesOf(issue).some(matchesText);
}

const labelColors = new Map();

function columnLabelName(column) {
  return detailVersion ? flowLabelName(column) : VERSION_LABELS.get(column);
}

function labelColor(labelName) {
  return labelName ? labelColors.get(labelName) || "" : "";
}

function rememberLabelColors(labels) {
  for (const label of labels) {
    if (/^[0-9a-f]{6}$/i.test(label.color || "")) labelColors.set(label.name, label.color);
  }
}

async function loadColumnLabelColors() {
  try {
    rememberLabelColors(await repoLabels(ORGANIZATION, "roadmap"));
  } catch {
    // Dots keep the neutral fallback color when the labels cannot be loaded.
  }
}

function renderBoard() {
  closeMoveMenu();
  board.replaceChildren();
  refreshFilterOptions();
  const topLevelIssues = issues.filter((issue) => isOnBoard(issue) && !isNestedSubIssue(issue) && matchesSearch(issue) && passesFilters(issue));
  const visibleIssues = detailVersion ? topLevelIssues.filter((issue) => issueVersion(issue) === detailVersion) : topLevelIssues;
  for (const version of COLUMNS) {
    const columnIssues = visibleIssues.filter((issue) => issueColumn(issue) === version);
    const column = document.createElement("section");
    column.className = "column";
    column.dataset.version = version;
    column.setAttribute("aria-label", `${version}, ${columnIssues.length} issues`);
    column.innerHTML = `
      <header class="column-heading">
        <md-icon-button class="collapse-button" aria-label="Collapse ${escapeHtml(version)}"><md-icon>expand_more</md-icon></md-icon-button>
        <span class="column-dot" aria-hidden="true"></span>
        <h2>${!detailVersion && DETAIL_VERSIONS.includes(version) ? `<a class="column-link" href="detail.html?version=${version}" aria-label="Open ${version} details">${version}<md-icon>chevron_right</md-icon></a>` : `<span class="column-title-static">${escapeHtml(version)}</span>`}</h2>
        <span class="issue-count">${columnIssues.length}</span>
      </header>
      <div class="issue-list" data-drop-version="${escapeHtml(version)}"></div>
    `;
    column.dataset.dropVersion = version;
    const dotColor = labelColor(columnLabelName(version));
    if (dotColor) column.querySelector(".column-dot").style.background = `#${dotColor}`;
    const collapseButton = column.querySelector(".collapse-button");
    const applyCollapsed = () => {
      const collapsed = collapsedColumns.has(version);
      column.classList.toggle("collapsed", collapsed);
      collapseButton.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${version}`);
      collapseButton.querySelector("md-icon").textContent = collapsed ? "chevron_right" : "expand_more";
    };
    collapseButton.addEventListener("click", () => {
      if (collapsedColumns.has(version)) collapsedColumns.delete(version);
      else collapsedColumns.add(version);
      saveCollapsedColumns();
      applyCollapsed();
    });
    applyCollapsed();
    column.addEventListener("dragover", onDragOver);
    column.addEventListener("dragleave", onDragLeave);
    column.addEventListener("drop", onDrop);
    const issueList = column.querySelector(".issue-list");

    if (columnIssues.length === 0) {
      issueList.innerHTML = '<p class="empty-column"><md-icon>inbox</md-icon>No issues</p>';
    } else {
      for (const issue of columnIssues) issueList.append(createIssueCard(issue));
    }
    board.append(column);
  }
}

function subIssueProgress(issue) {
  const summary = issue.sub_issues_summary;
  if (summary && summary.total > 0) return { done: summary.completed, total: summary.total };
  const loaded = subIssuesOf(issue).length;
  return loaded > 0 ? { done: 0, total: loaded } : null;
}

function cardStats(issue) {
  const assignees = (issue.assignees || [])
    .slice(0, 3)
    .map((user) => `<img class="avatar" src="${escapeHtml(user.avatar_url)}" alt="${escapeHtml(user.login)}" title="${escapeHtml(user.login)}" width="24" height="24" loading="lazy">`)
    .join("");
  const progress = subIssueProgress(issue);
  const parts = [];
  if (assignees) parts.push(`<span class="avatars">${assignees}</span>`);
  parts.push(`<span class="stat" title="Comments"><md-icon>chat_bubble</md-icon>${issue.comments || 0}</span>`);
  if (progress) {
    parts.push(`<span class="stat" title="Subissues completed"><md-icon>checklist</md-icon>${progress.done}/${progress.total}</span>`);
  }
  parts.push(developmentSlotHtml(issue));
  return `<div class="card-stats">${parts.join("")}</div>`;
}

function createIssueCard(issue) {
  const card = document.createElement("article");
  card.className = "issue-card";
  card.draggable = Boolean(accessToken);
  card.dataset.issueId = issue.id;
  card.addEventListener("dragstart", onDragStart);
  card.addEventListener("dragend", onDragEnd);

  const repository = issue.repository_url.split("/").slice(-2).join("/");
  const number = issue.number;
  const labels = issue.labels
    .filter((label) => (detailVersion ? !isFlowLabel(label.name) : !isVersionLabel(label.name)))
    .map(labelChipHtml)
    .join("");

  card.innerHTML = `
    <div class="issue-meta">
      ${statusIconHtml(issue)}
      <span class="repo-name" title="${escapeHtml(repository)}">${escapeHtml(repository)}</span>
      <span class="issue-number">#${number}</span>
    </div>
    <button class="issue-title" type="button">${escapeHtml(issue.title)}</button>
    ${labels ? `<div class="issue-labels" aria-label="Issue labels">${labels}</div>` : ""}
    ${cardStats(issue)}
    <div class="card-footer">
      ${pendingClosures.has(issue.id) ? '<md-text-button class="undo-close-button" type="button" data-issue-id="${issue.id}">${undoLabel(issue)}</md-text-button>' : ""}
      <md-text-button class="move-button" data-issue-id="${issue.id}" trailing-icon aria-label="Move issue #${number} to ${detailVersion ? "stage" : "version"}" ${accessToken ? "" : "disabled"}>
        Move to
        <md-icon slot="icon">arrow_drop_down</md-icon>
      </md-text-button>
    </div>
  `;

  const subIssues = subIssuesOf(issue);
  if (subIssues.length > 0) {
    const accordion = document.createElement("details");
    accordion.className = "subissues";
    const accordionSummary = document.createElement("summary");
    const progress = subIssueProgress(issue);
    accordionSummary.textContent = `Subissues (${progress ? `${progress.done}/${progress.total}` : subIssues.length})`;
    accordion.append(accordionSummary);
    for (const subIssue of subIssues) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "subissue-link";
      item.textContent = `#${subIssue.number} ${subIssue.title}`;
      item.addEventListener("click", () => openPanel(subIssue));
      accordion.append(item);
    }
    card.insertBefore(accordion, card.querySelector(".card-footer"));
  }

  card.querySelector(".issue-title").addEventListener("click", () => openPanel(issue));
  card.querySelector(".undo-close-button")?.addEventListener("click", () => reopenIssue(issue));
  const moveButton = card.querySelector(".move-button");
  moveButton.addEventListener("click", () => openMoveMenu(issue, moveButton));
  return card;
}

let moveMenu = null;
let moveMenuIssue = null;
let moveMenuItems = [];

function createMoveMenu() {
  moveMenu = document.createElement("md-menu");
  moveMenu.setAttribute("positioning", "popover");
  moveMenu.quick = true;
  moveMenuItems = COLUMNS.map((column) => {
    const item = document.createElement("md-menu-item");
    item.dataset.column = column;
    item.innerHTML = `<md-icon slot="start"></md-icon><div slot="headline">${escapeHtml(column)}</div>`;
    item.addEventListener("click", () => {
      if (moveMenuIssue) moveIssue(moveMenuIssue, column);
    });
    return item;
  });
  moveMenu.append(...moveMenuItems);
  document.body.append(moveMenu);
}

function openMoveMenu(issue, anchor) {
  if (!moveMenu) createMoveMenu();
  // Opening a menu that is closing, or re-anchoring an open one, makes it jump; close first and reopen after the close completes.
  if (moveMenu.open) {
    const sameAnchor = moveMenu.anchorElement === anchor;
    moveMenu.addEventListener("closed", () => {
      if (!sameAnchor) showMoveMenu(issue, anchor);
    }, { once: true });
    moveMenu.close();
    return;
  }
  showMoveMenu(issue, anchor);
}

function showMoveMenu(issue, anchor) {
  moveMenuIssue = issue;
  const current = issueColumn(issue);
  for (const item of moveMenuItems) {
    const isCurrent = item.dataset.column === current;
    item.toggleAttribute("selected", isCurrent);
    item.querySelector("md-icon").textContent = isCurrent ? "check" : "";
  }
  moveMenu.anchorElement = anchor;
  requestAnimationFrame(() => {
    moveMenu.open = true;
  });
}

function closeMoveMenu() {
  if (moveMenu && moveMenu.open) moveMenu.close();
}

function onDragStart(event) {
  if (!accessToken) {
    event.preventDefault();
    return;
  }
  event.dataTransfer.setData("text/plain", event.currentTarget.dataset.issueId);
  event.dataTransfer.effectAllowed = "move";
  event.currentTarget.classList.add("dragging");
}

function onDragEnd(event) {
  event.currentTarget.classList.remove("dragging");
  document.querySelectorAll(".column.drag-over").forEach((column) => column.classList.remove("drag-over"));
  removeDropIndicator();
}

function removeDropIndicator() {
  document.querySelectorAll(".drop-indicator").forEach((indicator) => indicator.remove());
}

function showDropIndicator(column, y) {
  const list = column.querySelector(".issue-list");
  let indicator = list.querySelector(".drop-indicator");
  if (!indicator) {
    removeDropIndicator();
    indicator = document.createElement("div");
    indicator.className = "drop-indicator";
  }
  const cards = [...list.querySelectorAll(".issue-card:not(.dragging)")];
  const next = cards.find((card) => y < card.getBoundingClientRect().top + card.offsetHeight / 2);
  if (next) list.insertBefore(indicator, next);
  else list.append(indicator);
}

function onDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  const column = event.currentTarget.closest(".column");
  column.classList.add("drag-over");
  if (!column.classList.contains("collapsed")) showDropIndicator(column, event.clientY);
}

function onDragLeave(event) {
  if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
    event.currentTarget.closest(".column").classList.remove("drag-over");
    removeDropIndicator();
  }
}

async function onDrop(event) {
  event.preventDefault();
  const version = event.currentTarget.dataset.dropVersion;
  const issueId = Number(event.dataTransfer.getData("text/plain"));
  const issue = issues.find((item) => item.id === issueId);
  event.currentTarget.closest(".column").classList.remove("drag-over");
  removeDropIndicator();
  if (issue && version) await moveIssue(issue, version);
}

async function moveIssue(issue, version) {
  if (!accessToken) {
    openAuthDialog();
    return;
  }
  const previous = issueColumn(issue);
  if (!COLUMNS.includes(version) || previous === version) return;

  const [owner, repository] = issue.repository_url.split("/").slice(-2);
  let labels;
  if (detailVersion) {
    labels = issue.labels
      .map((label) => label.name)
      .filter((labelName) => !isFlowLabel(labelName));
    labels.push(flowLabelName(version));
  } else {
    labels = issue.labels
      .map((label) => label.name)
      .filter((labelName) => !isVersionLabel(labelName));
    labels.push(VERSION_LABELS.get(version));
    const hasFlow = labels.some((labelName) => isFlowLabel(labelName));
    if (DETAIL_VERSIONS.includes(version) && !hasFlow) labels.push(flowLabelName(DEFAULT_FLOW));
  }

  document.querySelectorAll(`.move-button[data-issue-id="${issue.id}"]`).forEach((button) => {
    button.disabled = true;
  });
  notice.hidden = true;

  try {
    const updated = await githubRequest(
      `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${issue.number}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ labels })
      },
      accessToken
    );
    const index = issues.findIndex((item) => item.id === issue.id);
    if (index !== -1) issues[index] = updated;
    saveIssuesCache();
    renderBoard();
    summary.textContent = summaryText();
    refreshPanel();
    showUndo(updated, previous);
  } catch (error) {
    showNotice(`Could not update ${repository}#${issue.number}: ${apiErrorMessage(error)}`, true);
    renderBoard();
  }
}

function showUndo(issue, previousColumn) {
  clearTimeout(undoTimer);
  document.querySelector(".snackbar")?.remove();
  const toast = document.createElement("div");
  toast.className = "snackbar";
  toast.setAttribute("role", "status");
  const text = document.createElement("span");
  text.textContent = `Moved #${issue.number} to ${issueColumn(issue)}.`;
  const button = document.createElement("md-text-button");
  button.textContent = "Undo";
  button.addEventListener("click", () => {
    toast.remove();
    moveIssue(issue, previousColumn);
  });
  toast.append(text, button);
  document.body.append(toast);
  undoTimer = setTimeout(() => toast.remove(), 8000);
}

function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.toggle("error", isError);
  notice.hidden = false;
}

const CLOSE_UNDO_MS = 30000;
const ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const pendingClosures = new Map();
let countdownTimer = 0;

function pendingSeconds(issue) {
  const pending = pendingClosures.get(issue.id);
  return pending ? Math.max(0, Math.ceil((pending.deadline - Date.now()) / 1000)) : 0;
}

function undoLabel(issue) {
  return `Undo close (${pendingSeconds(issue)}s)`;
}

function tickCountdown() {
  if (pendingClosures.size === 0) {
    clearInterval(countdownTimer);
    countdownTimer = 0;
    return;
  }
  for (const issue of issues) {
    if (!pendingClosures.has(issue.id)) continue;
    const label = undoLabel(issue);
    document.querySelectorAll(`.undo-close-button[data-issue-id="${issue.id}"]`).forEach((button) => {
      button.textContent = label;
    });
    if (panelElements && panelIssueId === issue.id) panelElements.reopenButton.textContent = label;
  }
}

function isClosed(issue) {
  return issue.state === "closed";
}

// A freshly closed issue stays on the board until its undo window ends.
function isOnBoard(issue) {
  return !isClosed(issue) || pendingClosures.has(issue.id);
}

function issueStatus(issue) {
  if (!isClosed(issue)) return { key: "open", icon: "adjust", label: "Open" };
  if (issue.state_reason === "not_planned") return { key: "not-planned", icon: "block", label: "Closed as not planned" };
  if (issue.state_reason === "duplicate") return { key: "duplicate", icon: "block", label: "Closed as duplicate" };
  return { key: "completed", icon: "check_circle", label: "Closed" };
}

function statusIconHtml(issue) {
  const status = issueStatus(issue);
  return `<md-icon class="status-icon status-${status.key}" role="img" title="${status.label}" aria-label="${status.label}">${status.icon}</md-icon>`;
}

function clearPendingClosure(issue) {
  clearTimeout(pendingClosures.get(issue.id)?.timer);
  pendingClosures.delete(issue.id);
}

function startPendingClosure(issue) {
  clearPendingClosure(issue);
  const timer = setTimeout(() => {
    pendingClosures.delete(issue.id);
    renderBoard();
    summary.textContent = summaryText();
    refreshPanel();
  }, CLOSE_UNDO_MS);
  pendingClosures.set(issue.id, { timer, deadline: Date.now() + CLOSE_UNDO_MS });
  if (!countdownTimer) countdownTimer = setInterval(tickCountdown, 1000);
}

function issueEndpoint(issue) {
  const [owner, repository] = repoOf(issue);
  return `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${issue.number}`;
}

async function changeIssueState(issue, body, duplicateOf = null) {
  if (!accessToken) {
    openAuthDialog();
    return false;
  }
  const [owner, repository] = repoOf(issue);
  notice.hidden = true;
  if (panelElements) panelElements.error.hidden = true;
  stateChangeBusy = true;
  refreshPanel();
  try {
    if (duplicateOf) {
      await githubRequest(
        `${issueEndpoint(issue)}/comments`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: `Duplicate of ${repoOf(duplicateOf).join("/")}#${duplicateOf.number}` })
        },
        accessToken
      );
    }
    const updated = await githubRequest(
      issueEndpoint(issue),
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      accessToken
    );
    const merged = mergeUpdatedIssue(issue, updated);
    if (isClosed(merged)) startPendingClosure(merged);
    else clearPendingClosure(merged);
    saveIssuesCache();
    renderBoard();
    summary.textContent = summaryText();
    return true;
  } catch (error) {
    const message = `Could not update ${repository}#${issue.number}: ${apiErrorMessage(error)}`;
    if (panelIssueId === issue.id) showPanelError(message);
    else showNotice(message, true);
    return false;
  } finally {
    stateChangeBusy = false;
    refreshPanel();
  }
}

function closeIssue(issue, reason, duplicateOf = null) {
  return changeIssueState(issue, { state: "closed", state_reason: reason }, duplicateOf);
}

function reopenIssue(issue) {
  return changeIssueState(issue, { state: "open", state_reason: "reopened" });
}

let stateChangeBusy = false;
let closeMenu = null;
let duplicateDialog = null;
let duplicateTarget = null;

function setupCloseControls(panel) {
  const group = panel.querySelector(".close-split");
  closeMenu = document.createElement("md-menu");
  closeMenu.setAttribute("positioning", "popover");
  closeMenu.quick = true;
  closeMenu.anchorElement = group;
  closeMenu.innerHTML = `
    <md-menu-item data-action="completed"><md-icon slot="start">check_circle</md-icon><div slot="headline">Close as completed</div></md-menu-item>
    <md-menu-item data-action="not_planned"><md-icon slot="start">block</md-icon><div slot="headline">Close as not planned</div></md-menu-item>
    <md-menu-item data-action="duplicate"><md-icon slot="start">content_copy</md-icon><div slot="headline">Close as duplicate</div></md-menu-item>
  `;
  group.append(closeMenu);
  const toggle = panel.querySelector(".close-menu-toggle");
  const syncExpanded = () => toggle.setAttribute("aria-expanded", String(closeMenu.open));
  toggle.addEventListener("click", () => {
    closeMenu.open = !closeMenu.open;
    syncExpanded();
  });
  closeMenu.addEventListener("opened", syncExpanded);
  closeMenu.addEventListener("closed", syncExpanded);
  panel.querySelector(".close-main").addEventListener("click", () => {
    const issue = currentIssue();
    if (issue) closeIssue(issue, "completed");
  });
  closeMenu.addEventListener("close-menu", (event) => {
    const action = event.detail.initiator?.dataset?.action;
    const issue = currentIssue();
    if (!action || !issue) return;
    if (action === "duplicate") openDuplicateDialog(issue);
    else closeIssue(issue, action);
  });
  panel.querySelector(".reopen-button").addEventListener("click", () => {
    const issue = currentIssue();
    if (issue) reopenIssue(issue);
  });
}

function renderStatusControls(issue) {
  const { statusPill, closeSplit, reopenButton } = panelElements;
  statusPill.hidden = Boolean(issue.draft);
  closeSplit.hidden = Boolean(issue.draft) || isClosed(issue);
  reopenButton.hidden = Boolean(issue.draft) || !isClosed(issue);
  if (issue.draft) return;
  const status = issueStatus(issue);
  statusPill.className = `status-pill status-pill-${status.key}`;
  statusPill.innerHTML = `<md-icon>${status.icon}</md-icon><span>${status.label}</span>`;
  const disabled = !accessToken || stateChangeBusy;
  closeSplit.querySelector(".close-main").disabled = disabled;
  closeSplit.querySelector(".close-menu-toggle").disabled = disabled;
  reopenButton.disabled = disabled;
  reopenButton.textContent = pendingClosures.has(issue.id) ? undoLabel(issue) : "Reopen issue";
}

function ensureDuplicateDialog() {
  if (duplicateDialog) return duplicateDialog;
  duplicateDialog = document.createElement("md-dialog");
  duplicateDialog.className = "duplicate-dialog";
  duplicateDialog.innerHTML = `
    <div slot="headline">Close as duplicate</div>
    <div slot="content" class="duplicate-content">
      <p class="dialog-copy">Pick the original issue. A "Duplicate of …" comment will be added before closing.</p>
      <md-outlined-text-field class="duplicate-search" label="Search issues" placeholder="Title, number or repository" autocomplete="off">
        <md-icon slot="leading-icon">search</md-icon>
      </md-outlined-text-field>
      <div class="duplicate-results" role="listbox" aria-label="Issues"></div>
    </div>
    <div slot="actions">
      <md-text-button class="duplicate-cancel" type="button">Cancel</md-text-button>
      <md-filled-button class="duplicate-confirm" type="button" disabled>Close as duplicate</md-filled-button>
    </div>
  `;
  document.body.append(duplicateDialog);
  duplicateDialog.querySelector(".duplicate-search").addEventListener("input", renderDuplicateResults);
  duplicateDialog.querySelector(".duplicate-cancel").addEventListener("click", () => duplicateDialog.close());
  duplicateDialog.querySelector(".duplicate-confirm").addEventListener("click", async () => {
    const issue = duplicateDialog.issue;
    const original = duplicateTarget;
    if (!issue || !original) return;
    duplicateDialog.close();
    await closeIssue(issue, "duplicate", original);
  });
  return duplicateDialog;
}

function openDuplicateDialog(issue) {
  const dialog = ensureDuplicateDialog();
  dialog.issue = issue;
  duplicateTarget = null;
  dialog.querySelector(".duplicate-search").value = "";
  renderDuplicateResults();
  dialog.show();
}

function renderDuplicateResults() {
  const dialog = duplicateDialog;
  const term = dialog.querySelector(".duplicate-search").value.trim().toLowerCase().replace(/^#/, "");
  const matches = issues
    .filter((item) => item.id !== dialog.issue.id)
    .filter((item) => !term || `${item.title} ${repoOf(item).join("/")} ${item.number}`.toLowerCase().includes(term))
    .slice(0, 30);
  const list = dialog.querySelector(".duplicate-results");
  list.replaceChildren();
  dialog.querySelector(".duplicate-confirm").disabled = !duplicateTarget;
  if (matches.length === 0) {
    list.innerHTML = '<p class="duplicate-empty">No matching issue.</p>';
    return;
  }
  for (const item of matches) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "duplicate-option";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(duplicateTarget?.id === item.id));
    option.innerHTML = `${statusIconHtml(item)}<span class="duplicate-title">${escapeHtml(item.title)}</span><span class="duplicate-ref">${escapeHtml(repoOf(item).join("/"))}#${item.number}</span>`;
    option.addEventListener("click", () => {
      duplicateTarget = item;
      renderDuplicateResults();
    });
    list.append(option);
  }
}

let doneDialog = null;
let doneTab = 0;

function ensureDoneDialog() {
  if (doneDialog) return doneDialog;
  doneDialog = document.createElement("md-dialog");
  doneDialog.className = "done-dialog";
  doneDialog.innerHTML = `
    <div slot="headline">Done</div>
    <div slot="content" class="done-content">
      <md-tabs aria-label="Closed issues">
        <md-primary-tab id="done-tab">Done</md-primary-tab>
        <md-primary-tab id="archived-tab">Archived</md-primary-tab>
      </md-tabs>
      <div class="done-list"></div>
    </div>
    <div slot="actions"><md-text-button class="done-close" type="button">Close</md-text-button></div>
  `;
  document.body.append(doneDialog);
  const tabs = doneDialog.querySelector("md-tabs");
  tabs.addEventListener("change", () => {
    doneTab = tabs.activeTabIndex;
    renderDoneList();
  });
  doneDialog.querySelector(".done-close").addEventListener("click", () => doneDialog.close());
  return doneDialog;
}

function closedIssueGroups() {
  const now = Date.now();
  const closed = issues
    .filter((issue) => isClosed(issue) && !pendingClosures.has(issue.id))
    .filter((issue) => !detailVersion || issueVersion(issue) === detailVersion)
    .sort((a, b) => Date.parse(b.closed_at) - Date.parse(a.closed_at));
  const isArchived = (issue) => now - Date.parse(issue.closed_at) > ARCHIVE_AFTER_MS;
  return { done: closed.filter((issue) => !isArchived(issue)), archived: closed.filter(isArchived) };
}

function renderDoneList() {
  const { done, archived } = closedIssueGroups();
  const dialog = ensureDoneDialog();
  dialog.querySelector("#done-tab").textContent = `Done (${done.length})`;
  dialog.querySelector("#archived-tab").textContent = `Archived (${archived.length})`;
  const list = dialog.querySelector(".done-list");
  const shown = doneTab === 0 ? done : archived;
  list.replaceChildren();
  if (shown.length === 0) {
    list.innerHTML = `<p class="duplicate-empty">${doneTab === 0 ? "No issue closed in the last 30 days." : "No archived issue."}</p>`;
    return;
  }
  for (const issue of shown) {
    const item = document.createElement("div");
    item.className = "duplicate-option done-row";
    const closedOn = new Date(issue.closed_at).toLocaleDateString();
    item.innerHTML = `<button type="button" class="done-open">${statusIconHtml(issue)}<span class="duplicate-title">${escapeHtml(issue.title)}</span><span class="duplicate-ref">${escapeHtml(repoOf(issue).join("/"))}#${issue.number} · ${closedOn}</span></button>${developmentTriggerHtml(issue)}`;
    item.querySelector(".done-open").addEventListener("click", () => {
      dialog.close();
      openPanel(issue);
    });
    list.append(item);
  }
}

function refreshDoneDialog() {
  if (!doneDialog || !doneDialog.open) return;
  const list = doneDialog.querySelector(".done-list");
  const scrollTop = list.scrollTop;
  renderDoneList();
  list.scrollTop = scrollTop;
}

function openDoneDialog() {
  const dialog = ensureDoneDialog();
  doneTab = 0;
  dialog.querySelector("md-tabs").activeTabIndex = 0;
  renderDoneList();
  dialog.show();
}

const doneButton = document.querySelector("#done-button");
if (doneButton) doneButton.addEventListener("click", openDoneDialog);

function clearTokenField() {
  tokenInput.value = "";
  tokenInput.reset?.();
}

function setAuthState(login) {
  currentLogin = login;
  authStatus.textContent = login ? `Connected as @${login}` : "Read-only";
  authStatus.classList.toggle("connected", Boolean(login));
  authButton.textContent = login ? "Disconnect" : "Connect GitHub";
}

function openAuthDialog() {
  authError.hidden = true;
  clearTokenField();
  rememberInput.checked = false;
  authDialog.show();
  tokenInput.focus();
}

function closeAuthDialog() {
  authDialog.close();
}

async function connectToken(event) {
  event.preventDefault();
  const candidate = tokenInput.value.trim();
  if (!candidate) return;
  submitAuth.disabled = true;
  submitAuth.textContent = "Checking…";
  authError.hidden = true;

  try {
    const user = await githubRequest(`${API_ROOT}/user`, {}, candidate);
    accessToken = candidate;
    clearIssuesCache();
    storeToken(candidate, rememberInput.checked);
    clearTokenField();
    setAuthState(user.login);
    closeAuthDialog();
    renderBoard();
    refreshPanel();
    if (loadFailed) loadIssues({ force: true });
    else loadPullRequests({ force: true });
  } catch (error) {
    authError.textContent = `Could not connect: ${apiErrorMessage(error)}`;
    authError.hidden = false;
  } finally {
    submitAuth.disabled = false;
    submitAuth.textContent = "Connect";
  }
}

function disconnectToken() {
  accessToken = "";
  clearIssuesCache();
  clearStoredToken();
  clearTokenField();
  setAuthState("");
  clearIssuePulls();
  renderBoard();
  refreshPanel();
}

const META_LABELS = ["Epic", "WIP"];
// Button group order; labels that are not listed come last, in GitHub's order.
const GROUP_ORDER = {
  Type: ["Feature", "Bug", "Tech Debt"],
  Stack: ["Client", "Server", "Data", "Build", "Documentation"],
  Priority: ["Tweak", "Urgent", "Security"]
};
const REQUIRED_GROUPS = [
  { prefix: "Type", message: "Select a type." },
  { prefix: "Stack", message: "Select at least one stack." }
];
let panelErrors = new Set();
const labelCache = new Map();
const assigneeCache = new Map();
let panelElements = null;
let panelIssueId = null;
let panelClosing = false;
let panelMeta = { labels: null, assignees: null };
let panelBusy = false;
let descriptionEditor = null;
const PANEL_WIDTH_KEY = "roadmap-panel-width";
const PANEL_MIN_WIDTH = 560;
const PANEL_OVERLAY_GAP = 48;
const PANEL_KEY_STEP = 32;

function labelPrefix(labelName) {
  const match = /^\s*([^:]+?)\s*:/.exec(labelName);
  return match ? match[1].toLowerCase() : "";
}

function labelValue(labelName) {
  const match = /^\s*[^:]+?\s*:\s*(.*)$/.exec(labelName);
  return match && match[1] ? match[1] : labelName;
}

function hasPrefix(labelName, prefix) {
  return labelPrefix(labelName) === prefix.toLowerCase();
}

function textColorFor(hex) {
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  return (red * 299 + green * 587 + blue * 114) / 1000 > 140 ? "#1f2328" : "#ffffff";
}

function labelChipHtml(label) {
  const color = /^[0-9a-f]{6}$/i.test(label.color || "") ? label.color : "";
  const style = color ? ` style="background:#${color};border-color:#${color};color:${textColorFor(color)}"` : "";
  return `<span class="label-chip"${style} title="${escapeHtml(label.name)}">${escapeHtml(labelValue(label.name))}</span>`;
}

function repoOf(issue) {
  return issue.repository_url.split("/").slice(-2);
}

const DRAFT_ID = "new-issue";
let draftIssue = null;

function newDraftIssue(repository = DEFAULT_REPOSITORY) {
  return {
    id: DRAFT_ID,
    draft: true,
    title: "",
    body: "",
    labels: [],
    assignees: [],
    relationships: emptyRelations(),
    repository_url: `${API_ROOT}/repos/${ORGANIZATION}/${repository}`
  };
}

function currentIssue() {
  if (panelIssueId === DRAFT_ID) return draftIssue;
  return issues.find((item) => item.id === panelIssueId);
}

async function fetchAllPages(url) {
  const results = [];
  for (let page = 1; page <= 10; page += 1) {
    const separator = url.includes("?") ? "&" : "?";
    const items = await githubRequest(`${url}${separator}per_page=${PAGE_SIZE}&page=${page}`, {}, accessToken);
    results.push(...items);
    if (items.length < PAGE_SIZE) break;
  }
  return results;
}

function cachedRequest(cache, key, load) {
  if (!cache.has(key)) {
    cache.set(key, load().catch((error) => {
      cache.delete(key);
      throw error;
    }));
  }
  return cache.get(key);
}

function repoLabels(owner, repository) {
  return cachedRequest(labelCache, `${owner}/${repository}`, () =>
    fetchAllPages(`${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/labels`)
  );
}

function repoAssignees(owner, repository) {
  return cachedRequest(assigneeCache, `${owner}/${repository}`, () =>
    fetchAllPages(`${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/assignees`)
  );
}

function ensurePanel() {
  if (panelElements) return panelElements;
  const overlay = document.createElement("div");
  overlay.className = "panel-overlay";
  overlay.hidden = true;
  const panel = document.createElement("aside");
  panel.className = "issue-panel";
  panel.hidden = true;
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Issue details");
  panel.innerHTML = `
    <header class="panel-header">
      <md-icon-button class="panel-close" aria-label="Close panel"><md-icon>close</md-icon></md-icon-button>
      <div class="panel-ref"></div>
      <md-text-button class="panel-github-link" target="_blank">View on GitHub<md-icon slot="icon">open_in_new</md-icon></md-text-button>
    </header>
    <div class="panel-content">
      <div class="panel-main">
        <p class="panel-error auth-error" role="alert" hidden></p>
        <p class="panel-readonly"><md-icon>lock</md-icon>Connect GitHub to edit this issue.</p>
        <button type="button" class="panel-repo-field" data-picker="repository" aria-haspopup="dialog" hidden>
          <md-ripple></md-ripple><md-focus-ring></md-focus-ring>
          <span class="repo-field-label">Repository</span>
          <span class="repo-field-value"></span>
          <md-icon>arrow_drop_down</md-icon>
        </button>
        <div class="status-pill" hidden></div>
        <md-outlined-text-field class="panel-title-input" label="Title" type="text" autocomplete="off"></md-outlined-text-field>
        <div class="panel-save-row">
          <div class="close-split">
            <md-outlined-button class="close-main" type="button"><md-icon slot="icon">check_circle</md-icon>Close issue</md-outlined-button>
            <md-outlined-icon-button class="close-menu-toggle" type="button" aria-label="More close options" aria-haspopup="menu" aria-expanded="false"><md-icon>arrow_drop_down</md-icon></md-outlined-icon-button>
          </div>
          <md-outlined-button class="reopen-button" type="button" hidden>Reopen issue</md-outlined-button>
          <md-filled-button class="panel-save" type="button">Save</md-filled-button>
        </div>
      </div>
      <aside class="panel-settings" aria-labelledby="panel-settings-heading">
        <h2 class="panel-settings-heading" id="panel-settings-heading">Settings</h2>
        <fieldset class="panel-controls"></fieldset>
      </aside>
    </div>
    <div class="panel-resizer" role="separator" aria-orientation="vertical" aria-label="Resize panel" tabindex="0"></div>
  `;
  descriptionEditor = createMarkdownEditor({
    renderPreview: renderMarkdownPreview,
    onSubmit: saveTitleAndDescription
  });
  panel.querySelector(".panel-save-row").before(descriptionEditor.element);
  document.body.append(overlay, panel);
  panelElements = {
    overlay,
    panel,
    ref: panel.querySelector(".panel-ref"),
    link: panel.querySelector(".panel-github-link"),
    error: panel.querySelector(".panel-error"),
    readonly: panel.querySelector(".panel-readonly"),
    title: panel.querySelector(".panel-title-input"),
    repoField: panel.querySelector(".panel-repo-field"),
    resizer: panel.querySelector(".panel-resizer"),
    save: panel.querySelector(".panel-save"),
    statusPill: panel.querySelector(".status-pill"),
    closeSplit: panel.querySelector(".close-split"),
    reopenButton: panel.querySelector(".reopen-button"),
    controls: panel.querySelector(".panel-controls")
  };
  overlay.addEventListener("click", requestClosePanel);
  panel.querySelector(".panel-close").addEventListener("click", requestClosePanel);
  panelElements.repoField.addEventListener("click", () => togglePicker("repository"));
  panelElements.title.addEventListener("input", () => {
    panelElements.title.error = false;
    clearResolvedValidationError();
  });
  panelElements.save.addEventListener("click", saveTitleAndDescription);
  setupCloseControls(panel);
  setupPanelResizer(panel, panelElements.resizer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panelIssueId !== null && !document.querySelector("md-dialog[open]")) requestClosePanel();
  });
  return panelElements;
}

function panelWidthBounds() {
  const max = Math.max(0, window.innerWidth - PANEL_OVERLAY_GAP);
  return { min: Math.min(PANEL_MIN_WIDTH, max), max };
}

function setPanelWidth(panel, resizer, width, persist) {
  const { min, max } = panelWidthBounds();
  const clamped = Math.round(Math.min(max, Math.max(min, width)));
  panel.style.setProperty("--panel-width", `${clamped}px`);
  resizer.setAttribute("aria-valuemin", String(min));
  resizer.setAttribute("aria-valuemax", String(max));
  resizer.setAttribute("aria-valuenow", String(clamped));
  if (!persist) return;
  try {
    localStorage.setItem(PANEL_WIDTH_KEY, String(clamped));
  } catch {
    // Storage may be unavailable; the width then lasts only for this page view.
  }
}

function setupPanelResizer(panel, resizer) {
  let saved = PANEL_MIN_WIDTH;
  try {
    saved = Number(localStorage.getItem(PANEL_WIDTH_KEY)) || PANEL_MIN_WIDTH;
  } catch {
    // Use the minimum width when storage is unavailable.
  }
  setPanelWidth(panel, resizer, saved, false);

  resizer.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    resizer.setPointerCapture(event.pointerId);
    panel.classList.add("is-resizing");
  });
  resizer.addEventListener("pointermove", (event) => {
    if (resizer.hasPointerCapture(event.pointerId)) setPanelWidth(panel, resizer, window.innerWidth - event.clientX, false);
  });
  const stopResizing = (event) => {
    if (!resizer.hasPointerCapture(event.pointerId)) return;
    resizer.releasePointerCapture(event.pointerId);
    panel.classList.remove("is-resizing");
    setPanelWidth(panel, resizer, panel.getBoundingClientRect().width, true);
  };
  resizer.addEventListener("pointerup", stopResizing);
  resizer.addEventListener("pointercancel", stopResizing);

  resizer.addEventListener("keydown", (event) => {
    const current = panel.getBoundingClientRect().width;
    const { min, max } = panelWidthBounds();
    const widths = {
      ArrowLeft: current + PANEL_KEY_STEP,
      ArrowRight: current - PANEL_KEY_STEP,
      Home: min,
      End: max
    };
    if (!(event.key in widths)) return;
    event.preventDefault();
    setPanelWidth(panel, resizer, widths[event.key], true);
  });
  window.addEventListener("resize", () => {
    if (!panel.hidden) setPanelWidth(panel, resizer, panel.getBoundingClientRect().width, false);
  });
}

async function renderMarkdownPreview(text) {
  const issue = currentIssue();
  const body = { text, mode: "gfm" };
  if (issue) body.context = repoOf(issue).join("/");
  const response = await fetch(`${API_ROOT}/markdown`, {
    method: "POST",
    headers: { ...requestHeaders(accessToken), "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    const failure = new Error(`GitHub returned ${response.status}.`);
    failure.rateLimited = response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
    failure.authenticated = Boolean(accessToken);
    throw failure.rateLimited ? new Error(apiErrorMessage(failure)) : failure;
  }
  return response.text();
}

function openPanel(issue) {
  const elements = ensurePanel();
  flushIssueSaves();
  panelIssueId = issue.id;
  panelMeta = { labels: null, assignees: null };
  panelErrors = new Set();
  resetPanelExtras();
  closePicker(false);
  elements.title.error = false;
  elements.title.value = issue.title;
  descriptionEditor.showWrite();
  descriptionEditor.value = issue.body || "";
  elements.error.hidden = true;
  elements.overlay.hidden = false;
  elements.panel.hidden = false;
  refreshPanel();
  elements.title.focus();
  loadPanelMeta(issue);
}

let draftRepoNames = [DEFAULT_REPOSITORY];

async function openNewIssuePanel() {
  if (!accessToken) {
    openAuthDialog();
    return;
  }
  draftIssue = newDraftIssue();
  draftRepoNames = [DEFAULT_REPOSITORY];
  openPanel(draftIssue);
  const names = await loadOrganizationRepos();
  if (panelIssueId !== DRAFT_ID) return;
  draftRepoNames = names;
  if (picker?.anchorKey === "repository") refreshPicker(true);
}

function chooseDraftRepo(name) {
  if (panelIssueId !== DRAFT_ID || repoOf(draftIssue)[1] === name) return;
  draftIssue.repository_url = `${API_ROOT}/repos/${ORGANIZATION}/${name}`;
  draftIssue.labels = [];
  draftIssue.assignees = [];
  panelMeta = { labels: null, assignees: null };
  panelErrors = new Set();
  if (picker?.anchorKey !== "repository") closePicker(false);
  refreshPanel();
  loadPanelMeta(draftIssue);
}

function loadPanelMeta(issue) {
  const [owner, repository] = repoOf(issue);
  const issueId = issue.id;
  const isCurrent = () => panelIssueId === issueId && repoOf(currentIssue()).join("/") === `${owner}/${repository}`;
  repoLabels(owner, repository)
    .then((labels) => {
      if (isCurrent()) {
        panelMeta.labels = labels.map((label) => label.name);
        panelMeta.colors = new Map(labels.map((label) => [label.name, label.color]));
      }
    })
    .catch((error) => {
      if (isCurrent()) showPanelError(`Could not load labels: ${apiErrorMessage(error)}`);
    })
    .finally(() => {
      if (isCurrent()) renderPanelControls();
    });
  repoAssignees(owner, repository)
    .then((users) => {
      if (isCurrent()) panelMeta.assignees = users;
    })
    .catch(() => {
      if (isCurrent()) panelMeta.assignees = [];
    })
    .finally(() => {
      if (isCurrent()) renderPanelControls();
    });
}

function hasUnsavedChanges() {
  const issue = currentIssue();
  if (!issue || !panelElements) return false;
  const title = panelElements.title.value.trim();
  const body = descriptionEditor.value;
  if (issue.draft) return Boolean(title || body.trim() || issue.labels.length || issue.assignees.length || relationCount(issue.relationships));
  return title !== issue.title || body !== (issue.body || "");
}

let discardDialog = null;

function confirmDiscard() {
  if (!discardDialog) {
    discardDialog = document.createElement("md-dialog");
    discardDialog.innerHTML = `
      <div slot="headline">Discard changes?</div>
      <form id="discard-form" slot="content" method="dialog">Your unsaved changes will be lost.</form>
      <div slot="actions">
        <md-text-button form="discard-form" value="keep" autofocus>Keep editing</md-text-button>
        <md-filled-button form="discard-form" value="discard">Discard</md-filled-button>
      </div>
    `;
    document.body.append(discardDialog);
  }
  discardDialog.returnValue = "";
  return new Promise((resolve) => {
    discardDialog.addEventListener("closed", () => resolve(discardDialog.returnValue === "discard"), { once: true });
    discardDialog.show();
  });
}

async function requestClosePanel() {
  if (panelIssueId === null || panelClosing) return;
  panelClosing = true;
  try {
    if (!hasUnsavedChanges() || (await confirmDiscard())) closePanel();
  } finally {
    panelClosing = false;
  }
}

function closePanel() {
  if (!panelElements) return;
  flushIssueSaves();
  closePicker(false);
  panelIssueId = null;
  draftIssue = null;
  panelElements.overlay.hidden = true;
  panelElements.panel.hidden = true;
}

function refreshPanel() {
  if (panelIssueId === null || !panelElements) return;
  const issue = currentIssue();
  if (!issue) {
    closePanel();
    return;
  }
  const [owner, repository] = repoOf(issue);
  panelElements.ref.textContent = issue.draft ? "New issue" : `${owner}/${repository} #${issue.number}`;
  panelElements.link.hidden = Boolean(issue.draft);
  if (!issue.draft) panelElements.link.href = issue.html_url;
  panelElements.repoField.hidden = !issue.draft;
  panelElements.repoField.disabled = !accessToken;
  panelElements.repoField.querySelector(".repo-field-value").textContent = repository;
  panelElements.save.textContent = issue.draft ? "Create" : "Save";
  panelElements.readonly.hidden = Boolean(accessToken);
  panelElements.title.disabled = !accessToken;
  descriptionEditor.disabled = !accessToken;
  panelElements.save.disabled = !accessToken;
  renderStatusControls(issue);
  renderPanelControls();
}

function showPanelError(message) {
  if (!panelElements) return;
  panelElements.error.textContent = message;
  panelElements.error.hidden = false;
  delete panelElements.error.dataset.validation;
}

function clearResolvedValidationError() {
  const { error, title } = panelElements;
  if (error.dataset.validation && !title.error && panelErrors.size === 0) {
    error.hidden = true;
    delete error.dataset.validation;
  }
}

function isGroupMissing(issue, prefix) {
  return groupOptions(issue, prefix).length > 0 && !issue.labels.some((label) => hasPrefix(label.name, prefix));
}

function validateDraft(draft, title) {
  if (panelMeta.labels === null) {
    showPanelError("The repository labels are not loaded yet. Wait a moment or pick another repository.");
    return false;
  }
  panelErrors = new Set(REQUIRED_GROUPS.filter(({ prefix }) => isGroupMissing(draft, prefix)).map(({ prefix }) => prefix));
  panelElements.title.error = !title;
  panelElements.title.errorText = title ? "" : "Enter a title.";
  renderPanelControls();
  if (title && panelErrors.size === 0) return true;
  showPanelError("Complete the highlighted fields before creating the issue.");
  panelElements.error.dataset.validation = "true";
  if (!title) panelElements.title.focus();
  else panelElements.controls.querySelector(".has-error .connected-button")?.focus();
  return false;
}

async function saveTitleAndDescription() {
  const issue = currentIssue();
  if (!issue) return;
  const title = panelElements.title.value.trim();
  if (issue.draft) {
    if (validateDraft(issue, title)) await createIssue(issue, title);
    return;
  }
  if (!title) {
    showPanelError("The title cannot be empty.");
    return;
  }
  panelElements.save.textContent = "Saving…";
  const updated = await patchIssueNow(issue, { title, body: descriptionEditor.value });
  panelElements.save.textContent = "Save";
  if (updated) {
    panelElements.title.value = updated.title;
    descriptionEditor.value = updated.body || "";
  }
}

async function createIssue(draft, title) {
  if (!accessToken) {
    openAuthDialog();
    return;
  }
  const [owner, repository] = repoOf(draft);
  panelBusy = true;
  panelElements.error.hidden = true;
  panelElements.save.textContent = "Creating…";
  renderPanelControls();
  try {
    const created = await githubRequest(
      `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          body: descriptionEditor.value,
          labels: draft.labels.map((label) => label.name),
          assignees: draft.assignees.map((user) => user.login)
        })
      },
      accessToken
    );
    issues.unshift(created);
    saveIssuesCache();
    renderBoard();
    summary.textContent = summaryText();
    closePanel();
    const failures = await applyDraftRelationships(created, draft.relationships);
    if (failures.length) showNotice(`Issue #${created.number} was created, but some relationships could not be set: ${failures.join(", ")}.`, true);
  } catch (error) {
    showPanelError(`Could not create the issue: ${apiErrorMessage(error)}`);
  } finally {
    panelBusy = false;
    refreshPanel();
  }
}

async function patchIssue(issue, body) {
  if (!accessToken) {
    openAuthDialog();
    return;
  }
  if (issue.draft) {
    if (body.labels) issue.labels = body.labels.map((name) => ({ name }));
    if (body.assignees) {
      const known = [...(panelMeta.assignees || []), ...issue.assignees];
      issue.assignees = body.assignees.map((login) => known.find((user) => user.login === login));
    }
    renderPanelControls();
    return;
  }
  queueIssueSave(issue, body);
}

// Labels and assignees of an existing issue change instantly on screen. The requests are sent in the
// background once no other change has been made for SAVE_DELAY, so quick clicks end up in a single request.
const SAVE_DELAY = 600;
const issueSaves = new Map();

function labelObject(issue, name) {
  return issue.labels.find((label) => label.name === name) || { name, color: panelMeta.colors?.get(name) || labelColor(name) };
}

function applyIssueChange(index, body) {
  const issue = issues[index];
  const next = { ...issue };
  if (body.labels) next.labels = body.labels.map((name) => labelObject(issue, name));
  if (body.assignees) {
    const known = [...(panelMeta.assignees || []), ...(issue.assignees || [])];
    next.assignees = body.assignees.map((login) => known.find((user) => user.login === login)).filter(Boolean);
  }
  issues[index] = next;
}

function queueIssueSave(issue, body) {
  const index = issues.findIndex((item) => item.id === issue.id);
  if (index === -1) return;
  let save = issueSaves.get(issue.id);
  if (!save) {
    save = { issue, body: {}, timer: null, running: false, confirmed: { labels: issues[index].labels, assignees: issues[index].assignees } };
    issueSaves.set(issue.id, save);
  }
  applyIssueChange(index, body);
  Object.assign(save.body, body);
  clearTimeout(save.timer);
  save.timer = setTimeout(() => {
    save.timer = null;
    runIssueSave(issue);
  }, SAVE_DELAY);
  panelElements.error.hidden = true;
  renderBoard();
  summary.textContent = summaryText();
  refreshPanel();
}

async function runIssueSave(issue) {
  const save = issueSaves.get(issue.id);
  if (!save || save.running) return;
  clearTimeout(save.timer);
  save.timer = null;
  const body = save.body;
  save.body = {};
  if (Object.keys(body).length === 0) {
    issueSaves.delete(issue.id);
    return;
  }
  save.running = true;
  const [owner, repository] = repoOf(issue);
  try {
    const updated = await githubRequest(
      `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${issue.number}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      accessToken
    );
    save.confirmed = { labels: updated.labels, assignees: updated.assignees };
    mergeUpdatedIssue(issue, updated);
  } catch (error) {
    // Go back to what GitHub has, and drop the changes made since.
    clearTimeout(save.timer);
    save.timer = null;
    save.body = {};
    const index = issues.findIndex((item) => item.id === issue.id);
    if (index !== -1) issues[index] = { ...issues[index], ...save.confirmed };
    const message = `Could not update ${repository}#${issue.number}: ${apiErrorMessage(error)}`;
    if (panelIssueId === issue.id) showPanelError(message);
    else showNotice(message, true);
  } finally {
    save.running = false;
    if (save.timer === null && Object.keys(save.body).length > 0) runIssueSave(issue);
    else if (save.timer === null) issueSaves.delete(issue.id);
    saveIssuesCache();
    renderBoard();
    summary.textContent = summaryText();
    refreshPanel();
  }
}

function flushIssueSaves() {
  for (const save of issueSaves.values()) {
    if (save.timer === null) continue;
    clearTimeout(save.timer);
    save.timer = null;
    runIssueSave(save.issue);
  }
}

window.addEventListener("beforeunload", (event) => {
  if (issueSaves.size === 0) return;
  flushIssueSaves();
  event.preventDefault();
});

function mergeUpdatedIssue(issue, updated) {
  const index = issues.findIndex((item) => item.id === issue.id);
  const base = index === -1 ? issue : issues[index];
  const merged = { ...base, ...updated };
  const save = issueSaves.get(issue.id);
  // Keep the on-screen labels and assignees when newer changes are waiting to be saved.
  if (save && (save.timer !== null || Object.keys(save.body).length > 0)) {
    merged.labels = base.labels;
    merged.assignees = base.assignees;
  }
  if (index !== -1) issues[index] = merged;
  return merged;
}

async function patchIssueNow(issue, body) {
  const [owner, repository] = repoOf(issue);
  panelElements.error.hidden = true;
  try {
    const updated = await githubRequest(
      `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${issue.number}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      accessToken
    );
    const merged = mergeUpdatedIssue(issue, updated);
    saveIssuesCache();
    renderBoard();
    summary.textContent = summaryText();
    return merged;
  } catch (error) {
    showPanelError(`Could not update ${repository}#${issue.number}: ${apiErrorMessage(error)}`);
    return null;
  } finally {
    refreshPanel();
  }
}

function missingLabelWarning(missing, repository) {
  if (!panelMeta.labels || missing.length === 0) return "";
  const text = missing.map((name) => `Expected ${name} label is missing from the ${repository} repo`).join(". ");
  return `<md-icon class="label-warning" role="img" tabindex="0" title="${escapeHtml(text)}" aria-label="${escapeHtml(text)}">warning</md-icon>`;
}

function missingFrom(expected) {
  return panelMeta.labels ? expected.filter((name) => !panelMeta.labels.includes(name)) : [];
}

function groupOptions(issue, prefix) {
  const names = new Set();
  for (const name of panelMeta.labels || []) if (hasPrefix(name, prefix)) names.add(name);
  for (const label of issue.labels) if (hasPrefix(label.name, prefix)) names.add(label.name);
  return [...names];
}

function panelFlow(issue) {
  const names = issue.labels.map((label) => label.name);
  return FLOWS.find((item) => names.includes(flowLabelName(item))) || (issueVersion(issue) === "Unassigned" ? "" : DEFAULT_FLOW);
}

function orderedGroupOptions(issue, prefix) {
  const options = groupOptions(issue, prefix);
  const order = GROUP_ORDER[prefix];
  if (!order) return options;
  const rank = (name) => {
    const index = order.indexOf(labelValue(name));
    return index === -1 ? order.length : index;
  };
  return options.sort((a, b) => rank(a) - rank(b));
}

function renderPanelControls() {
  if (!panelElements || panelIssueId === null) return;
  const issue = currentIssue();
  if (!issue) return;
  ensurePanelExtras(issue);
  const repository = repoOf(issue)[1];
  const names = issue.labels.map((label) => label.name);
  const version = issueVersion(issue);
  const flow = panelFlow(issue);
  const locked = !accessToken || panelBusy;
  const disabled = locked ? "disabled" : "";

  // One chip per setting; it shows the current value and opens a menu with the choices.
  const menuChip = (id, label, options, current, { warning = "", emptyText = "Select…", noneText = "" } = {}) => {
    const items = noneText ? [{ value: "", text: noneText }, ...options] : options;
    const shown = options.find(({ value }) => value === current)?.text || emptyText;
    return `
    <div class="control">
      <span class="control-label">${label}${warning}</span>
      ${options.length === 0 ? '<p class="empty-note">No labels in this repo.</p>' : `
      <div class="menu-chip">
        <md-assist-chip id="chip-${id}" class="menu-chip-button" aria-label="${label}: ${escapeHtml(shown)}" aria-haspopup="menu" data-menu="${id}" ${disabled}>
          <span class="chip-content"><span>${escapeHtml(shown)}</span><md-icon>arrow_drop_down</md-icon></span>
        </md-assist-chip>
        <md-menu id="menu-${id}" anchor="chip-${id}" positioning="popover" quick aria-label="${label}">
          ${items.map(({ value, text }) => `<md-menu-item data-chip="${id}" data-value="${escapeHtml(value)}" ${value === current ? "selected" : ""}><div slot="headline">${escapeHtml(text)}</div></md-menu-item>`).join("")}
        </md-menu>
      </div>`}
    </div>`;
  };
  const metaSwitches = META_LABELS.map((meta) => {
    const labelName = `Meta : ${meta}`;
    const checked = names.some((name) => hasPrefix(name, "Meta") && labelValue(name).toLowerCase() === meta.toLowerCase());
    return `
      <label class="switch-row">
        <md-switch data-meta="${meta}" aria-label="${meta}" ${checked ? "selected" : ""} ${disabled}></md-switch>
        <span>${meta}</span>
        ${missingLabelWarning(missingFrom([labelName]), repository)}
      </label>`;
  }).join("");

  const buttonGroup = (prefix, mode, required = false) => {
    const options = orderedGroupOptions(issue, prefix);
    const mandatory = required && options.length > 0;
    const invalid = mandatory && panelErrors.has(prefix) && isGroupMissing(issue, prefix);
    const message = REQUIRED_GROUPS.find((group) => group.prefix === prefix)?.message;
    const labelId = `group-${prefix.toLowerCase()}`;
    return `
      <div class="control ${invalid ? "has-error" : ""}">
        <span class="control-label" id="${labelId}">${prefix}${mandatory ? '<span class="required-mark" aria-hidden="true">*</span><span class="visually-hidden">(required)</span>' : ""}</span>
        ${options.length === 0 ? '<p class="empty-note">No labels in this repo.</p>' : `
        <div class="connected-group" role="group" aria-labelledby="${labelId}" ${invalid ? `aria-describedby="${labelId}-error"` : ""} data-mode="${mode}" ${required ? 'data-required="true"' : ""}>
          ${options.map((name) => `<button type="button" class="connected-button" data-group-label="${escapeHtml(name)}" data-prefix="${prefix}" aria-pressed="${names.includes(name)}" title="${escapeHtml(labelValue(name))}" ${disabled}><md-ripple></md-ripple><md-focus-ring></md-focus-ring><span>${escapeHtml(labelValue(name))}</span></button>`).join("")}
        </div>`}
        ${invalid ? `<p class="field-error" id="${labelId}-error" role="alert">${message}</p>` : ""}
      </div>`;
  };

  const versionWarning = missingLabelWarning(missingFrom(VERSIONS.map((item) => VERSION_LABELS.get(item))), repository);
  const flowWarning = missingLabelWarning(missingFrom(FLOWS.map(flowLabelName)), repository);
  const blockedCurrent = names.find((name) => hasPrefix(name, "Blocked")) || "";
  const blockedOptions = groupOptions(issue, "Blocked").map((name) => ({ value: name, text: labelValue(name) }));

  panelElements.controls.disabled = locked;
  panelElements.controls.innerHTML = `
    ${assigneesSectionHtml(issue, disabled)}
    <section class="workflow-section">
      <h3>Workflow</h3>
      <div class="workflow-chips">
        ${menuChip("version", "Version", VERSIONS.map((item) => ({ value: item, text: item })), version, { warning: versionWarning })}
        ${menuChip("flow", "Flow", FLOWS.map((item) => ({ value: item, text: item })), flow, { warning: flowWarning })}
        ${menuChip("blocked", "Blocked", blockedOptions, blockedCurrent, { noneText: "None" })}
      </div>
    </section>
    <section class="other-section">
      <h3>Labels</h3>
      <div class="switches">${metaSwitches}</div>
      ${buttonGroup("Type", "exclusive", true)}
      ${buttonGroup("Stack", "multi", true)}
      ${buttonGroup("Priority", "clearable")}
    </section>
    ${developmentSectionHtml(issue)}
    ${relationshipsSectionHtml(issue, disabled)}
  `;
  bindPanelControls(issue);
  if (picker) {
    positionPicker();
    refreshPicker(picker.config.live);
  }
}

function bindPanelControls(issue) {
  const controls = panelElements.controls;
  const names = issue.labels.map((label) => label.name);
  const withoutPrefix = (prefix) => names.filter((name) => !hasPrefix(name, prefix));

  const chipLabels = (group, value) => {
    if (group === "version") {
      if (value === issueVersion(issue)) return null;
      const labels = withoutPrefix("Version");
      labels.push(VERSION_LABELS.get(value));
      if (DETAIL_VERSIONS.includes(value) && !labels.some(isFlowLabel)) labels.push(flowLabelName(DEFAULT_FLOW));
      return labels;
    }
    if (group === "flow") {
      if (value === panelFlow(issue)) return null;
      return [...withoutPrefix("Flow"), flowLabelName(value)];
    }
    if (value === "") return withoutPrefix("Blocked");
    if (names.includes(value)) return null;
    return [...withoutPrefix("Blocked"), value];
  };

  controls.querySelectorAll("[data-menu]").forEach((chip) => {
    const menu = controls.querySelector(`#menu-${chip.dataset.menu}`);
    chip.addEventListener("click", () => {
      menu.open = !menu.open;
    });
  });

  controls.querySelectorAll("md-menu-item[data-chip]").forEach((item) => {
    item.addEventListener("click", () => {
      const labels = chipLabels(item.dataset.chip, item.dataset.value);
      if (labels) patchIssue(issue, { labels });
    });
  });

  controls.querySelectorAll("[data-meta]").forEach((input) => {
    input.addEventListener("change", () => {
      const meta = input.dataset.meta.toLowerCase();
      const labels = names.filter((name) => !(hasPrefix(name, "Meta") && labelValue(name).toLowerCase() === meta));
      if (input.selected) labels.push(`Meta : ${input.dataset.meta}`);
      patchIssue(issue, { labels });
    });
  });

  controls.querySelectorAll(".connected-button").forEach((button) => {
    button.addEventListener("click", () => {
      const { groupLabel: name, prefix } = button.dataset;
      const { mode, required } = button.parentElement.dataset;
      const selected = names.includes(name);
      const onlyOne = names.filter((item) => hasPrefix(item, prefix)).length === 1;
      if (selected && required && onlyOne) return;
      let labels = null;
      if (mode === "multi") labels = selected ? names.filter((item) => item !== name) : [...names, name];
      else if (!selected) labels = [...withoutPrefix(prefix), name];
      else if (mode === "clearable") labels = names.filter((item) => item !== name);
      panelErrors.delete(prefix);
      clearResolvedValidationError();
      if (labels) patchIssue(issue, { labels });
      else renderPanelControls();
    });
  });

  bindSettingsSections(controls, issue);
}

async function loadOrganizationRepos() {
  const names = new Set(["roadmap"]);
  for (const issue of issues) names.add(repoOf(issue)[1]);
  try {
    const repos = await fetchAllPages(`${API_ROOT}/orgs/${ORGANIZATION}/repos?type=public`);
    for (const repo of repos) if (!repo.archived) names.add(repo.name);
  } catch {
    // Fall back to the repositories seen on the board.
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

if (addButton) addButton.addEventListener("click", openNewIssuePanel);

if (document.body.dataset.page === "detail") {
  const title = document.querySelector("#page-title");
  if (detailVersion) title.textContent = `${detailVersion} — detailed view`;
  else {
    title.textContent = "Unknown version";
    board.innerHTML = '<div class="empty-state"><md-icon>view_column</md-icon><span>Choose Backlog, Next or Current from the <a href="./">main board</a>.</span></div>';
  }
}

refreshButton.addEventListener("click", () => loadIssues({ force: true }));
authButton.addEventListener("click", () => {
  if (accessToken) disconnectToken();
  else openAuthDialog();
});
authForm.addEventListener("submit", connectToken);
cancelAuth.addEventListener("click", closeAuthDialog);

searchInput.addEventListener("input", () => {
  searchTerm = searchInput.value.trim().toLowerCase();
  if (issues.length > 0) renderBoard();
});

initFilters();

async function restoreToken() {
  const saved = readStoredToken();
  if (!saved) return;
  try {
    const user = await githubRequest(`${API_ROOT}/user`, {}, saved);
    accessToken = saved;
    setAuthState(user.login);
    renderBoard();
    refreshPanel();
  } catch (error) {
    // Keep the saved token on rate limits and network errors; only drop it when GitHub rejects it.
    if (error.status === 401) clearStoredToken();
  }
}

restoreToken().finally(loadIssues);

function initThemeToggle() {
  const options = document.querySelectorAll("[data-theme-option]");
  const sync = () => {
    const theme = document.documentElement.dataset.theme;
    for (const option of options) option.setAttribute("aria-pressed", String(option.dataset.themeOption === theme));
  };
  for (const option of options) {
    option.addEventListener("click", () => {
      document.documentElement.dataset.theme = option.dataset.themeOption;
      try { localStorage.setItem("theme", option.dataset.themeOption); } catch (error) {}
      sync();
    });
  }
  sync();
}

initThemeToggle();
