// "Pull requests" dialog: every open pull request of the organization, with the issue it is linked to (Development area), if any.
// Loaded after development.js; it relies on globals declared there and in app.js (accessToken, githubRequest, escapeHtml…).

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

let openPulls = { time: 0, items: [], total: 0 };
let openPullsRun = 0;
let openPullsDialog = null;
let openPullsLoading = false;
let openPullsError = "";
let alertsOnly = false;

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
  if (!force && Date.now() - openPulls.time < OPEN_PULLS_TTL) return;
  const run = ++openPullsRun;
  openPullsLoading = true;
  openPullsError = "";
  renderOpenPulls();
  try {
    const result = await fetchOpenPulls(run);
    if (result) openPulls = { time: Date.now(), ...result };
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
  updatePullsBadge();
  renderOpenPulls();
}

function openPullAgeText(createdAt) {
  const days = Math.floor((Date.now() - Date.parse(createdAt)) / 86400000);
  if (days < 1) return "today";
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function updatePullsBadge() {
  const badge = document.querySelector("#pulls-badge");
  if (!badge) return;
  const count = accessToken ? openPulls.items.filter((pull) => pull.alert).length : 0;
  badge.hidden = count === 0;
  badge.textContent = count;
  const label = count === 0 ? "Pull requests" : `Pull requests, ${count} ${count === 1 ? "alert" : "alerts"}`;
  document.querySelector("#pulls-button")?.setAttribute("aria-label", label);
}

function openPullRowHtml(pull) {
  const state = pullState(pull);
  const linked = pull.issues.length > 0;
  const issueLinks = linked
    ? pull.issues
        .map(
          (issue) =>
            `<a class="pulls-issue-chip" href="${escapeHtml(issue.url)}" target="_blank" rel="noopener" title="${escapeHtml(issue.title)}"><md-icon>link</md-icon>${escapeHtml(issue.repo)}#${issue.number}</a>`
        )
        .join("")
    : '<span class="pulls-orphan-chip" title="Not linked to an issue in its Development area"><md-icon>link_off</md-icon>No issue</span>';
  const alertChip = pull.alert
    ? `<span class="pulls-alert-chip" title="${escapeHtml(pull.alert.text)}"><md-icon>warning</md-icon>${escapeHtml(pull.alert.text)}</span>`
    : "";
  return `
    <div class="duplicate-option done-row pulls-row ${linked ? "pulls-linked" : "pulls-orphan"}">
      <a class="done-open pulls-open" href="${escapeHtml(pull.url)}" target="_blank" rel="noopener">
        <md-icon class="${state.className}" title="${state.text}">${state.icon}</md-icon>
        <span class="duplicate-title">${escapeHtml(pull.title)}</span>
        <span class="duplicate-ref">${escapeHtml(pull.repo)}#${pull.number} · @${escapeHtml(pull.author)} · ${openPullAgeText(pull.createdAt)}</span>
      </a>
      <span class="pulls-issues">${alertChip}${issueLinks}</span>
    </div>`;
}

function ensureOpenPullsDialog() {
  if (openPullsDialog) return openPullsDialog;
  openPullsDialog = document.createElement("md-dialog");
  openPullsDialog.className = "done-dialog";
  openPullsDialog.innerHTML = `
    <div slot="headline">Open pull requests</div>
    <div slot="content" class="done-content">
      <div class="pulls-toolbar">
        <p class="pulls-summary" role="status"></p>
        <md-filter-chip class="pulls-alert-filter" label="Alerts only"></md-filter-chip>
      </div>
      <div class="done-list pulls-list"></div>
    </div>
    <div slot="actions">
      <md-text-button class="pulls-refresh" type="button">Refresh</md-text-button>
      <md-text-button class="pulls-close" type="button">Close</md-text-button>
    </div>
  `;
  document.body.append(openPullsDialog);
  openPullsDialog.querySelector(".pulls-alert-filter").addEventListener("click", (event) => {
    alertsOnly = event.currentTarget.selected;
    renderOpenPulls();
  });
  openPullsDialog.querySelector(".pulls-refresh").addEventListener("click", () => loadOpenPulls({ force: true }));
  openPullsDialog.querySelector(".pulls-close").addEventListener("click", () => openPullsDialog.close());
  return openPullsDialog;
}

function renderOpenPulls() {
  updatePullsBadge();
  if (!openPullsDialog || !openPullsDialog.open) return;
  const summaryElement = openPullsDialog.querySelector(".pulls-summary");
  const list = openPullsDialog.querySelector(".pulls-list");
  const refresh = openPullsDialog.querySelector(".pulls-refresh");
  const scrollTop = list.scrollTop;
  refresh.disabled = openPullsLoading || !accessToken;
  list.replaceChildren();

  if (!accessToken) {
    summaryElement.textContent = "";
    list.innerHTML = '<p class="duplicate-empty">Connect GitHub to list pull requests and their linked issues.</p>';
    return;
  }
  if (openPullsLoading && openPulls.items.length === 0) {
    summaryElement.textContent = "";
    list.innerHTML = '<div class="loading-state"><md-circular-progress indeterminate aria-label="Loading"></md-circular-progress><span>Loading pull requests…</span></div>';
    return;
  }
  const { items, total } = openPulls;
  const orphans = items.filter((pull) => pull.issues.length === 0).length;
  const alerts = items.filter((pull) => pull.alert).length;
  const shown = alertsOnly ? items.filter((pull) => pull.alert) : items;
  openPullsDialog.querySelector(".pulls-alert-filter").label = `Alerts only (${alerts})`;
  const truncated = total > items.length ? ` Showing the first ${items.length} of ${total}.` : "";
  summaryElement.textContent = openPullsError
    ? `Pull requests could not be loaded: ${openPullsError}`
    : `${items.length} open · ${orphans} without a linked issue · ${alerts} ${alerts === 1 ? "alert" : "alerts"}.${truncated}`;
  if (shown.length === 0 && !openPullsError) {
    list.innerHTML = `<p class="duplicate-empty">${alertsOnly ? "No pull request needs attention." : "No open pull request."}</p>`;
    return;
  }
  list.innerHTML = shown.map(openPullRowHtml).join("");
  list.scrollTop = scrollTop;
}

function openOpenPullsDialog() {
  const dialog = ensureOpenPullsDialog();
  dialog.show();
  renderOpenPulls();
  loadOpenPulls();
}

const pullsButton = document.querySelector("#pulls-button");
updatePullsBadge();
if (pullsButton) pullsButton.addEventListener("click", openOpenPullsDialog);
