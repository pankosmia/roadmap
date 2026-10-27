const ORGANIZATION = "pankosmia";
const API_ROOT = "https://api.github.com";
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
const closeDialog = document.querySelector("#close-dialog");
const cancelAuth = document.querySelector("#cancel-auth");
const submitAuth = document.querySelector("#submit-auth");
const rememberInput = document.querySelector("#remember-input");
const addButton = document.querySelector("#add-button");

let accessToken = "";
let issues = [];
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
    throw new Error(message);
  }
  return response.json();
}

function apiErrorMessage(error) {
  if (error.message.includes("rate limit")) {
    return "GitHub's unauthenticated API limit has been reached. Connect a token or try again later.";
  }
  return error.message;
}

async function loadIssues() {
  if (isLoading || (document.body.dataset.page === "detail" && !detailVersion)) return;
  isLoading = true;
  refreshButton.disabled = true;
  notice.hidden = true;
  board.innerHTML = '<div class="loading-state">Loading Pankosmia issues…</div>';
  summary.textContent = "Loading issues…";

  try {
    const query = encodeURIComponent(`org:${ORGANIZATION} is:issue is:open`);
    const firstPage = await githubRequest(
      `${API_ROOT}/search/issues?q=${query}&per_page=${PAGE_SIZE}&page=1`
    );
    const totalCount = firstPage.total_count;
    const pages = Math.ceil(Math.min(totalCount, 1000) / PAGE_SIZE);
    const results = [...firstPage.items];

    for (let page = 2; page <= pages; page += 1) {
      summary.textContent = `Loading issues… ${Math.min(results.length, totalCount)} of ${totalCount}`;
      const result = await githubRequest(
        `${API_ROOT}/search/issues?q=${query}&per_page=${PAGE_SIZE}&page=${page}`
      );
      results.push(...result.items);
    }

    issues = results;
    renderBoard();
    refreshPanel();
    summary.textContent = summaryText();
    if (totalCount > 1000) {
      showNotice(`GitHub search can return at most 1,000 results. Showing the first 1,000 of ${totalCount} issues.`);
    } else {
      const inconsistentIssues = issues.filter(
        (issue) => issue.labels.filter((label) => isVersionLabel(label.name)).length > 1
      ).length;
      if (inconsistentIssues > 0) {
        showNotice(
          `${inconsistentIssues} issue${inconsistentIssues === 1 ? " has" : "s have"} multiple Version labels. Moving an issue replaces all its Version labels with one.`
        );
      }
    }
  } catch (error) {
    board.innerHTML = '<div class="empty-state">Could not load issues from GitHub.</div>';
    summary.textContent = "Issues could not be loaded";
    showNotice(apiErrorMessage(error), true);
  } finally {
    isLoading = false;
    refreshButton.disabled = false;
  }
}

function summaryText() {
  const count = detailVersion ? issues.filter((issue) => issueVersion(issue) === detailVersion).length : issues.length;
  const scope = detailVersion ? `in ${detailVersion}` : "from public Pankosmia repositories";
  return `${count} ${count === 1 ? "issue" : "issues"} ${scope}`;
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

function renderBoard() {
  board.replaceChildren();
  const topLevelIssues = issues.filter((issue) => !isNestedSubIssue(issue) && matchesSearch(issue));
  const visibleIssues = detailVersion ? topLevelIssues.filter((issue) => issueVersion(issue) === detailVersion) : topLevelIssues;
  for (const version of COLUMNS) {
    const columnIssues = visibleIssues.filter((issue) => issueColumn(issue) === version);
    const column = document.createElement("section");
    column.className = "column";
    column.dataset.version = version;
    column.setAttribute("aria-label", `${version}, ${columnIssues.length} issues`);
    column.innerHTML = `
      <header class="column-heading">
        <div class="column-title-wrap">
          <span class="column-dot" aria-hidden="true"></span>
          <h2>${!detailVersion && DETAIL_VERSIONS.includes(version) ? `<a class="column-link" href="detail.html?version=${version}">${version}</a>` : escapeHtml(version)}</h2>
        </div>
        <div class="column-actions">
          <span class="issue-count">${columnIssues.length}</span>
          <button class="collapse-button" type="button" aria-expanded="true" aria-label="Collapse ${escapeHtml(version)}">▾</button>
        </div>
      </header>
      <div class="issue-list" data-drop-version="${escapeHtml(version)}"></div>
    `;
    column.dataset.dropVersion = version;
    const collapseButton = column.querySelector(".collapse-button");
    const applyCollapsed = () => {
      const collapsed = collapsedColumns.has(version);
      column.classList.toggle("collapsed", collapsed);
      collapseButton.setAttribute("aria-expanded", String(!collapsed));
      collapseButton.setAttribute("aria-label", `${collapsed ? "Expand" : "Collapse"} ${version}`);
      collapseButton.textContent = collapsed ? "▸" : "▾";
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
      issueList.innerHTML = '<p class="empty-column">No issues.</p>';
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
    .map((user) => `<img class="avatar" src="${escapeHtml(user.avatar_url)}" alt="${escapeHtml(user.login)}" title="${escapeHtml(user.login)}" width="20" height="20" loading="lazy">`)
    .join("");
  const progress = subIssueProgress(issue);
  const parts = [];
  if (assignees) parts.push(`<span class="avatars">${assignees}</span>`);
  parts.push(`<span class="stat" title="Comments">💬 ${issue.comments || 0}</span>`);
  if (progress) {
    parts.push(`<span class="stat" title="Subissues completed">☑ ${progress.done}/${progress.total}</span>`);
  }
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
      <span class="repo-name" title="${escapeHtml(repository)}">${escapeHtml(repository)}</span>
      <span class="issue-number">#${number}</span>
    </div>
    <button class="issue-title" type="button">${escapeHtml(issue.title)}</button>
    ${labels ? `<div class="issue-labels" aria-label="Issue labels">${labels}</div>` : ""}
    ${cardStats(issue)}
    <div class="card-footer">
      <label class="move-label" for="move-${issue.id}">Move to</label>
      <select class="move-select" id="move-${issue.id}" aria-label="Move issue #${number} to ${detailVersion ? "stage" : "version"}" ${accessToken ? "" : "disabled"}>
        ${COLUMNS.map((column) => `<option value="${escapeHtml(column)}" ${issueColumn(issue) === column ? "selected" : ""}>${escapeHtml(column)}</option>`).join("")}
      </select>
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
  const select = card.querySelector(".move-select");
  select.addEventListener("change", () => moveIssue(issue, select.value));
  return card;
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

  const selects = document.querySelectorAll(`.move-select[id="move-${issue.id}"]`);
  selects.forEach((select) => {
    select.disabled = true;
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
  document.querySelector(".undo-toast")?.remove();
  const toast = document.createElement("div");
  toast.className = "undo-toast";
  toast.setAttribute("role", "status");
  const text = document.createElement("span");
  text.textContent = `Moved #${issue.number} to ${issueColumn(issue)}.`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button button-secondary";
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

function openAuthDialog() {
  authError.hidden = true;
  tokenInput.value = "";
  rememberInput.checked = false;
  authDialog.showModal();
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
    storeToken(candidate, rememberInput.checked);
    tokenInput.value = "";
    authStatus.textContent = `Connected as @${user.login}`;
    authButton.textContent = "Disconnect";
    closeAuthDialog();
    renderBoard();
    refreshPanel();
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
  clearStoredToken();
  tokenInput.value = "";
  authStatus.textContent = "Read-only";
  authButton.textContent = "Connect GitHub";
  renderBoard();
  refreshPanel();
}

const META_LABELS = ["Epic", "WIP"];
const SINGLE_CHOICE_GROUPS = new Set(["Blocked"]);
const labelCache = new Map();
const assigneeCache = new Map();
const openDropdowns = new Set();
let panelElements = null;
let panelIssueId = null;
let panelMeta = { labels: null, assignees: null };
let panelBusy = false;

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

function currentIssue() {
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
      <div class="panel-ref"></div>
      <a class="panel-github-link" target="_blank" rel="noopener noreferrer">View on GitHub</a>
      <button class="dialog-close panel-close" type="button" aria-label="Close panel">×</button>
    </header>
    <div class="panel-body">
      <p class="panel-error auth-error" role="alert" hidden></p>
      <p class="panel-readonly">Connect GitHub to edit this issue.</p>
      <label for="panel-title-input">Title</label>
      <input id="panel-title-input" class="panel-title-input" type="text" autocomplete="off">
      <label for="panel-description-input">Description</label>
      <textarea id="panel-description-input" class="panel-description-input" rows="10"></textarea>
      <div class="panel-save-row">
        <button class="button button-primary panel-save" type="button">Save</button>
      </div>
      <fieldset class="panel-controls"></fieldset>
    </div>
  `;
  document.body.append(overlay, panel);
  panelElements = {
    overlay,
    panel,
    ref: panel.querySelector(".panel-ref"),
    link: panel.querySelector(".panel-github-link"),
    error: panel.querySelector(".panel-error"),
    readonly: panel.querySelector(".panel-readonly"),
    title: panel.querySelector(".panel-title-input"),
    description: panel.querySelector(".panel-description-input"),
    save: panel.querySelector(".panel-save"),
    controls: panel.querySelector(".panel-controls")
  };
  overlay.addEventListener("click", closePanel);
  panel.querySelector(".panel-close").addEventListener("click", closePanel);
  panelElements.save.addEventListener("click", saveTitleAndDescription);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panelIssueId !== null && !document.querySelector("dialog[open]")) closePanel();
  });
  return panelElements;
}

function openPanel(issue) {
  const elements = ensurePanel();
  panelIssueId = issue.id;
  panelMeta = { labels: null, assignees: null };
  openDropdowns.clear();
  elements.title.value = issue.title;
  elements.description.value = issue.body || "";
  elements.error.hidden = true;
  elements.overlay.hidden = false;
  elements.panel.hidden = false;
  refreshPanel();
  elements.title.focus();

  const [owner, repository] = repoOf(issue);
  const issueId = issue.id;
  repoLabels(owner, repository)
    .then((labels) => {
      if (panelIssueId === issueId) panelMeta.labels = labels.map((label) => label.name);
    })
    .catch((error) => {
      if (panelIssueId === issueId) showPanelError(`Could not load labels: ${apiErrorMessage(error)}`);
    })
    .finally(() => {
      if (panelIssueId === issueId) renderPanelControls();
    });
  repoAssignees(owner, repository)
    .then((users) => {
      if (panelIssueId === issueId) panelMeta.assignees = users;
    })
    .catch(() => {
      if (panelIssueId === issueId) panelMeta.assignees = [];
    })
    .finally(() => {
      if (panelIssueId === issueId) renderPanelControls();
    });
}

function closePanel() {
  if (!panelElements) return;
  panelIssueId = null;
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
  panelElements.ref.textContent = `${owner}/${repository} #${issue.number}`;
  panelElements.link.href = issue.html_url;
  panelElements.readonly.hidden = Boolean(accessToken);
  panelElements.title.disabled = !accessToken;
  panelElements.description.disabled = !accessToken;
  panelElements.save.disabled = !accessToken;
  renderPanelControls();
}

function showPanelError(message) {
  if (!panelElements) return;
  panelElements.error.textContent = message;
  panelElements.error.hidden = false;
}

async function saveTitleAndDescription() {
  const issue = currentIssue();
  if (!issue) return;
  const title = panelElements.title.value.trim();
  if (!title) {
    showPanelError("The title cannot be empty.");
    return;
  }
  panelElements.save.textContent = "Saving…";
  const updated = await patchIssue(issue, { title, body: panelElements.description.value });
  panelElements.save.textContent = "Save";
  if (updated) {
    panelElements.title.value = updated.title;
    panelElements.description.value = updated.body || "";
  }
}

async function patchIssue(issue, body) {
  if (!accessToken) {
    openAuthDialog();
    return null;
  }
  const [owner, repository] = repoOf(issue);
  panelBusy = true;
  panelElements.error.hidden = true;
  renderPanelControls();
  try {
    const updated = await githubRequest(
      `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${issue.number}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      },
      accessToken
    );
    const index = issues.findIndex((item) => item.id === issue.id);
    const merged = { ...(index === -1 ? issue : issues[index]), ...updated };
    if (index !== -1) issues[index] = merged;
    renderBoard();
    summary.textContent = summaryText();
    return merged;
  } catch (error) {
    showPanelError(`Could not update ${repository}#${issue.number}: ${apiErrorMessage(error)}`);
    return null;
  } finally {
    panelBusy = false;
    refreshPanel();
  }
}

function missingLabelWarning(missing, repository) {
  if (!panelMeta.labels || missing.length === 0) return "";
  const text = missing.map((name) => `Expected ${name} label is missing from the ${repository} repo`).join(". ");
  return `<span class="label-warning" role="img" tabindex="0" title="${escapeHtml(text)}" aria-label="${escapeHtml(text)}">⚠️</span>`;
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

function renderPanelControls() {
  if (!panelElements || panelIssueId === null) return;
  const issue = currentIssue();
  if (!issue) return;
  const repository = repoOf(issue)[1];
  const names = issue.labels.map((label) => label.name);
  const version = issueVersion(issue);
  const flow = FLOWS.find((item) => names.includes(flowLabelName(item))) || (version === "Unassigned" ? "" : DEFAULT_FLOW);
  const flowOptions = version === "Unassigned" ? ["", ...FLOWS] : FLOWS;
  const option = (value, text, selected) => `<option value="${escapeHtml(value)}" ${selected ? "selected" : ""}>${escapeHtml(text)}</option>`;

  const metaSwitches = META_LABELS.map((meta) => {
    const labelName = `Meta : ${meta}`;
    const checked = names.some((name) => hasPrefix(name, "Meta") && labelValue(name).toLowerCase() === meta.toLowerCase());
    return `
      <label class="switch-row">
        <input type="checkbox" role="switch" data-meta="${meta}" ${checked ? "checked" : ""}>
        <span class="switch-track" aria-hidden="true"></span>
        <span>${meta}</span>
        ${missingLabelWarning(missingFrom([labelName]), repository)}
      </label>`;
  }).join("");

  const multiGroup = (prefix) => {
    const options = groupOptions(issue, prefix);
    const selected = names.filter((name) => hasPrefix(name, prefix));
    const summaryText = selected.length ? selected.map(labelValue).join(", ") : "None";
    return `
      <div class="control">
        <span class="control-label">${prefix}</span>
        <details class="multi-select" data-group="${prefix}" ${openDropdowns.has(prefix) ? "open" : ""}>
          <summary>${escapeHtml(summaryText)}</summary>
          <div class="multi-options">
            ${options.length === 0 ? '<p class="empty-column">No labels in this repo.</p>' : options.map((name) => `
              <label class="check-row"><input type="checkbox" data-group-label="${escapeHtml(name)}" data-prefix="${prefix}" ${names.includes(name) ? "checked" : ""}> ${escapeHtml(labelValue(name))}</label>`).join("")}
          </div>
        </details>
      </div>`;
  };

  const blockedOptions = groupOptions(issue, "Blocked");
  const blockedCurrent = names.find((name) => hasPrefix(name, "Blocked")) || "";

  const assignable = panelMeta.assignees || [];
  const assigned = issue.assignees || [];
  const assigneeUsers = [...assignable];
  for (const user of assigned) if (!assigneeUsers.some((item) => item.login === user.login)) assigneeUsers.push(user);
  const assigneeSummary = assigned.length ? assigned.map((user) => `@${user.login}`).join(", ") : "No one assigned";

  panelElements.controls.disabled = !accessToken || panelBusy;
  panelElements.controls.innerHTML = `
    <section class="workflow-section">
      <h3>Workflow</h3>
      <div class="control">
        <label class="control-label" for="panel-version">Version ${missingLabelWarning(missingFrom(VERSIONS.map((item) => VERSION_LABELS.get(item))), repository)}</label>
        <select id="panel-version">${VERSIONS.map((item) => option(item, item, item === version)).join("")}</select>
      </div>
      <div class="control">
        <label class="control-label" for="panel-flow">Flow ${missingLabelWarning(missingFrom(FLOWS.map(flowLabelName)), repository)}</label>
        <select id="panel-flow">${flowOptions.map((item) => option(item, item || "— None —", item === flow)).join("")}</select>
      </div>
    </section>
    <section class="other-section">
      <h3>Labels</h3>
      <div class="switches">${metaSwitches}</div>
      ${multiGroup("Priority")}
      ${multiGroup("Type")}
      ${multiGroup("Stack")}
      <div class="control">
        <label class="control-label" for="panel-blocked">Blocked</label>
        <select id="panel-blocked">
          ${option("", "None", blockedCurrent === "")}
          ${blockedOptions.map((name) => option(name, labelValue(name), name === blockedCurrent)).join("")}
        </select>
      </div>
    </section>
    <section class="other-section">
      <h3>Assignees</h3>
      <div class="control">
        <details class="multi-select" data-group="assignees" ${openDropdowns.has("assignees") ? "open" : ""}>
          <summary>${escapeHtml(assigneeSummary)}</summary>
          <div class="multi-options">
            ${panelMeta.assignees === null ? '<p class="empty-column">Loading…</p>' : assigneeUsers.map((user) => `
              <label class="check-row"><input type="checkbox" data-assignee="${escapeHtml(user.login)}" ${assigned.some((item) => item.login === user.login) ? "checked" : ""}>
                <img class="avatar" src="${escapeHtml(user.avatar_url)}" alt="" width="20" height="20"> ${escapeHtml(user.login)}</label>`).join("")}
          </div>
        </details>
      </div>
    </section>
  `;
  bindPanelControls(issue);
}

function bindPanelControls(issue) {
  const controls = panelElements.controls;
  const names = issue.labels.map((label) => label.name);
  const withoutPrefix = (prefix) => names.filter((name) => !hasPrefix(name, prefix));

  controls.querySelectorAll("details").forEach((details) => {
    details.addEventListener("toggle", () => {
      if (details.open) openDropdowns.add(details.dataset.group);
      else openDropdowns.delete(details.dataset.group);
    });
  });

  controls.querySelector("#panel-version").addEventListener("change", (event) => {
    const value = event.target.value;
    const labels = withoutPrefix("Version");
    labels.push(VERSION_LABELS.get(value));
    if (DETAIL_VERSIONS.includes(value) && !labels.some(isFlowLabel)) labels.push(flowLabelName(DEFAULT_FLOW));
    patchIssue(issue, { labels });
  });

  controls.querySelector("#panel-flow").addEventListener("change", (event) => {
    const labels = withoutPrefix("Flow");
    if (event.target.value) labels.push(flowLabelName(event.target.value));
    patchIssue(issue, { labels });
  });

  controls.querySelectorAll("[data-meta]").forEach((input) => {
    input.addEventListener("change", () => {
      const meta = input.dataset.meta.toLowerCase();
      const labels = names.filter((name) => !(hasPrefix(name, "Meta") && labelValue(name).toLowerCase() === meta));
      if (input.checked) labels.push(`Meta : ${input.dataset.meta}`);
      patchIssue(issue, { labels });
    });
  });

  controls.querySelectorAll("[data-group-label]").forEach((input) => {
    input.addEventListener("change", () => {
      const name = input.dataset.groupLabel;
      const labels = names.filter((item) => item !== name);
      if (input.checked) labels.push(name);
      patchIssue(issue, { labels });
    });
  });

  controls.querySelector("#panel-blocked").addEventListener("change", (event) => {
    const labels = withoutPrefix("Blocked");
    if (event.target.value) labels.push(event.target.value);
    patchIssue(issue, { labels });
  });

  controls.querySelectorAll("[data-assignee]").forEach((input) => {
    input.addEventListener("change", () => {
      const current = (issue.assignees || []).map((user) => user.login).filter((login) => login !== input.dataset.assignee);
      if (input.checked) current.push(input.dataset.assignee);
      patchIssue(issue, { assignees: current });
    });
  });
}

let addDialog = null;

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

function ensureAddDialog() {
  if (addDialog) return addDialog;
  const dialog = document.createElement("dialog");
  dialog.className = "auth-dialog";
  dialog.setAttribute("aria-labelledby", "add-title");
  dialog.innerHTML = `
    <form>
      <button class="dialog-close" type="button" aria-label="Close">×</button>
      <p class="eyebrow">NEW ISSUE</p>
      <h2 id="add-title">Add an issue</h2>
      <label for="add-repo">Repository</label>
      <select id="add-repo"></select>
      <label for="add-title-input">Title</label>
      <input id="add-title-input" type="text" autocomplete="off" required>
      <p class="auth-error add-error" role="alert" hidden></p>
      <div class="dialog-actions">
        <button class="button button-secondary add-cancel" type="button">Cancel</button>
        <button class="button button-primary add-submit" type="submit">Create</button>
      </div>
    </form>
  `;
  document.body.append(dialog);
  const form = dialog.querySelector("form");
  const error = dialog.querySelector(".add-error");
  const submit = dialog.querySelector(".add-submit");
  const close = () => dialog.close();
  dialog.querySelector(".dialog-close").addEventListener("click", close);
  dialog.querySelector(".add-cancel").addEventListener("click", close);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const repository = dialog.querySelector("#add-repo").value;
    const title = dialog.querySelector("#add-title-input").value.trim();
    if (!repository || !title) return;
    submit.disabled = true;
    submit.textContent = "Creating…";
    error.hidden = true;
    try {
      const created = await githubRequest(
        `${API_ROOT}/repos/${encodeURIComponent(ORGANIZATION)}/${encodeURIComponent(repository)}/issues`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title })
        },
        accessToken
      );
      issues.unshift(created);
      renderBoard();
      summary.textContent = summaryText();
      dialog.close();
      openPanel(created);
    } catch (requestError) {
      error.textContent = `Could not create the issue: ${apiErrorMessage(requestError)}`;
      error.hidden = false;
    } finally {
      submit.disabled = false;
      submit.textContent = "Create";
    }
  });
  addDialog = dialog;
  return dialog;
}

async function openAddDialog() {
  if (!accessToken) {
    openAuthDialog();
    return;
  }
  const dialog = ensureAddDialog();
  const select = dialog.querySelector("#add-repo");
  dialog.querySelector("#add-title-input").value = "";
  dialog.querySelector(".add-error").hidden = true;
  select.innerHTML = '<option value="roadmap">roadmap</option>';
  dialog.showModal();
  dialog.querySelector("#add-title-input").focus();
  const names = await loadOrganizationRepos();
  select.innerHTML = names
    .map((name) => `<option value="${escapeHtml(name)}" ${name === "roadmap" ? "selected" : ""}>${escapeHtml(name)}</option>`)
    .join("");
}

if (addButton) addButton.addEventListener("click", openAddDialog);

if (document.body.dataset.page === "detail") {
  const title = document.querySelector("#page-title");
  if (detailVersion) title.textContent = `${detailVersion} — detailed view`;
  else {
    title.textContent = "Unknown version";
    board.innerHTML = '<div class="empty-state">Choose Backlog, Next or Current from the <a href="./">main board</a>.</div>';
  }
}

refreshButton.addEventListener("click", loadIssues);
authButton.addEventListener("click", () => {
  if (accessToken) disconnectToken();
  else openAuthDialog();
});
authForm.addEventListener("submit", connectToken);
closeDialog.addEventListener("click", closeAuthDialog);
cancelAuth.addEventListener("click", closeAuthDialog);

searchInput.addEventListener("input", () => {
  searchTerm = searchInput.value.trim().toLowerCase();
  if (issues.length > 0) renderBoard();
});

async function restoreToken() {
  const saved = readStoredToken();
  if (!saved) return;
  try {
    const user = await githubRequest(`${API_ROOT}/user`, {}, saved);
    accessToken = saved;
    authStatus.textContent = `Connected as @${user.login}`;
    authButton.textContent = "Disconnect";
    renderBoard();
    refreshPanel();
  } catch {
    clearStoredToken();
  }
}

loadIssues();
restoreToken();
