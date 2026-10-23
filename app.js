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

let accessToken = "";
let issues = [];
let isLoading = false;

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

function renderBoard() {
  board.replaceChildren();
  const visibleIssues = detailVersion ? issues.filter((issue) => issueVersion(issue) === detailVersion) : issues;
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
        <span class="issue-count">${columnIssues.length}</span>
      </header>
      <div class="issue-list" data-drop-version="${escapeHtml(version)}"></div>
    `;
    column.dataset.dropVersion = version;
    column.addEventListener("dragover", onDragOver);
    column.addEventListener("dragleave", onDragLeave);
    column.addEventListener("drop", onDrop);
    const issueList = column.querySelector(".issue-list");

    if (columnIssues.length === 0) {
      issueList.innerHTML = '<p class="empty-column">No issues in this ${detailVersion ? "stage" : "version"}</p>';
    } else {
      for (const issue of columnIssues) issueList.append(createIssueCard(issue));
    }
    board.append(column);
  }
}

function createIssueCard(issue) {
  const card = document.createElement("article");
  card.className = "issue-card";
  card.draggable = true;
  card.dataset.issueId = issue.id;
  card.addEventListener("dragstart", onDragStart);
  card.addEventListener("dragend", onDragEnd);

  const repository = issue.repository_url.split("/").slice(-2).join("/");
  const number = issue.number;
  const labels = issue.labels
    .filter((label) => !isVersionLabel(label.name) && !(detailVersion && isFlowLabel(label.name)))
    .slice(0, 5)
    .map((label) => `<span class="label-chip">${escapeHtml(label.name)}</span>`)
    .join("");

  card.innerHTML = `
    <div class="issue-meta">
      <span class="repo-name" title="${escapeHtml(repository)}">${escapeHtml(repository)}</span>
      <span class="issue-number">#${number}</span>
    </div>
    <a class="issue-title" href="${escapeHtml(issue.html_url)}" target="_blank" rel="noreferrer">${escapeHtml(issue.title)}</a>
    ${labels ? `<div class="issue-labels" aria-label="Issue labels">${labels}</div>` : ""}
    <div class="card-footer">
      <label class="move-label" for="move-${issue.id}">Move to</label>
      <select class="move-select" id="move-${issue.id}" aria-label="Move issue #${number} to ${detailVersion ? "stage" : "version"}" ${accessToken ? "" : "disabled"}>
        ${COLUMNS.map((column) => `<option value="${escapeHtml(column)}" ${issueColumn(issue) === column ? "selected" : ""}>${escapeHtml(column)}</option>`).join("")}
      </select>
    </div>
  `;

  const select = card.querySelector(".move-select");
  select.addEventListener("change", () => moveIssue(issue, select.value));
  return card;
}

function onDragStart(event) {
  if (!accessToken) {
    event.preventDefault();
    openAuthDialog();
    return;
  }
  event.dataTransfer.setData("text/plain", event.currentTarget.dataset.issueId);
  event.dataTransfer.effectAllowed = "move";
  event.currentTarget.classList.add("dragging");
}

function onDragEnd(event) {
  event.currentTarget.classList.remove("dragging");
  document.querySelectorAll(".column.drag-over").forEach((column) => column.classList.remove("drag-over"));
}

function onDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  event.currentTarget.closest(".column").classList.add("drag-over");
}

function onDragLeave(event) {
  if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
    event.currentTarget.closest(".column").classList.remove("drag-over");
  }
}

async function onDrop(event) {
  event.preventDefault();
  const version = event.currentTarget.dataset.dropVersion;
  const issueId = Number(event.dataTransfer.getData("text/plain"));
  const issue = issues.find((item) => item.id === issueId);
  event.currentTarget.closest(".column").classList.remove("drag-over");
  if (issue && version) await moveIssue(issue, version);
}

async function moveIssue(issue, version) {
  if (!accessToken) {
    openAuthDialog();
    return;
  }
  if (!COLUMNS.includes(version) || issueColumn(issue) === version) return;

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
  } catch (error) {
    showNotice(`Could not update ${repository}#${issue.number}: ${apiErrorMessage(error)}`, true);
    renderBoard();
  }
}

function showNotice(message, isError = false) {
  notice.textContent = message;
  notice.classList.toggle("error", isError);
  notice.hidden = false;
}

function openAuthDialog() {
  authError.hidden = true;
  tokenInput.value = "";
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
    tokenInput.value = "";
    authStatus.textContent = `Connected as @${user.login}`;
    authButton.textContent = "Disconnect";
    closeAuthDialog();
    renderBoard();
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
  tokenInput.value = "";
  authStatus.textContent = "Read-only";
  authButton.textContent = "Connect GitHub";
  renderBoard();
}

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

loadIssues();
