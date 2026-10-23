const ORGANIZATION = "pankosmia";
const API_ROOT = "https://api.github.com";
const PAGE_SIZE = 100;
const VERSIONS = ["Unassigned", "Backlog", "Next", "Current"];
const VERSION_LABELS = new Map(VERSIONS.map((version) => [version, `Version : ${version}`]));

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
  if (isLoading) return;
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
    const totalText = `${issues.length} ${issues.length === 1 ? "issue" : "issues"}`;
    summary.textContent = `${totalText} from public Pankosmia repositories`;
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

function isVersionLabel(labelName) {
  return /^Version\s*:/i.test(labelName);
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
  for (const version of VERSIONS) {
    const columnIssues = issues.filter((issue) => issueVersion(issue) === version);
    const column = document.createElement("section");
    column.className = "column";
    column.dataset.version = version;
    column.setAttribute("aria-label", `${version}, ${columnIssues.length} issues`);
    column.innerHTML = `
      <header class="column-heading">
        <div class="column-title-wrap">
          <span class="column-dot" aria-hidden="true"></span>
          <h2>${version}</h2>
        </div>
        <span class="issue-count">${columnIssues.length}</span>
      </header>
      <div class="issue-list" data-drop-version="${version}"></div>
    `;
    column.dataset.dropVersion = version;
    column.addEventListener("dragover", onDragOver);
    column.addEventListener("dragleave", onDragLeave);
    column.addEventListener("drop", onDrop);
    const issueList = column.querySelector(".issue-list");

    if (columnIssues.length === 0) {
      issueList.innerHTML = '<p class="empty-column">No issues in this version</p>';
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
    .filter((label) => !isVersionLabel(label.name))
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
      <select class="move-select" id="move-${issue.id}" aria-label="Move issue #${number} to version" ${accessToken ? "" : "disabled"}>
        ${VERSIONS.map((version) => `<option value="${version}" ${issueVersion(issue) === version ? "selected" : ""}>${version}</option>`).join("")}
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
  if (!VERSIONS.includes(version) || issueVersion(issue) === version) return;

  const [owner, repository] = issue.repository_url.split("/").slice(-2);
  const labels = issue.labels
    .map((label) => label.name)
    .filter((labelName) => !isVersionLabel(labelName));
  labels.push(VERSION_LABELS.get(version));

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
    summary.textContent = `${issues.length} ${issues.length === 1 ? "issue" : "issues"} from public Pankosmia repositories`;
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

refreshButton.addEventListener("click", loadIssues);
authButton.addEventListener("click", () => {
  if (accessToken) disconnectToken();
  else openAuthDialog();
});
authForm.addEventListener("submit", connectToken);
closeDialog.addEventListener("click", closeAuthDialog);
cancelAuth.addEventListener("click", closeAuthDialog);

loadIssues();
