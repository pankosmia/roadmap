// The address bar names the issue shown in the panel (?issue=repo/123), so that the page can be shared, and the browser
// history follows the panel: opening or switching to an issue adds an entry, Back goes to the previous issue or closes the panel.
// Loaded before app.js; it relies on globals declared there and in panel-tabs.js and panel-settings.js.

const ISSUE_PARAM = "issue";
// While above zero, the address bar is being read, not written (the panel follows a history change).
let issueUrlPauses = 0;

function parseIssueRef(value) {
  const match = /^(?:([^/]+)\/)?([^/]+)\/(\d+)$/.exec(value || "");
  return match ? { repo: `${match[1] || ORGANIZATION}/${match[2]}`, number: Number(match[3]) } : null;
}

function issueRefFromUrl() {
  return parseIssueRef(new URLSearchParams(window.location.search).get(ISSUE_PARAM));
}

function sameIssueRef(first, second) {
  if (!first || !second) return first === second;
  return first.number === second.number && first.repo.toLowerCase() === second.repo.toLowerCase();
}

function issueRef(issue) {
  return { repo: repoOf(issue).join("/"), number: issue.number };
}

function urlWithIssue(ref) {
  const params = new URLSearchParams(window.location.search);
  if (ref) params.set(ISSUE_PARAM, `${displayRepo(ref.repo)}/${ref.number}`);
  else params.delete(ISSUE_PARAM);
  // A slash is legal in a query and reads better than %2F.
  const query = params.toString().replaceAll("%2F", "/");
  return `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
}

// Puts the panel's issue in the address bar. The draft has no address: it leaves the URL as it is.
function syncIssueUrl({ replace = false } = {}) {
  if (issueUrlPauses > 0 || panelIssueId === DRAFT_ID) return;
  const issue = panelIssueId === null ? null : currentIssue();
  if (panelIssueId !== null && !issue) return;
  const ref = issue ? issueRef(issue) : null;
  if (sameIssueRef(ref, issueRefFromUrl())) return;
  try {
    window.history[replace ? "replaceState" : "pushState"](null, "", urlWithIssue(ref));
  } catch {
    // The address cannot be changed (a file opened from disk, for instance); the panel works without it.
  }
}

async function fetchIssueFromRef(ref) {
  const issue = await githubRequest(issueApiUrl(ref.repo, ref.number), {}, accessToken);
  if (issue.pull_request) throw new Error("this is a pull request, not an issue");
  return issues.find((item) => item.id === issue.id) || issue;
}

// Makes the panel show the issue named by the address bar: it switches to its tab, opens it, or closes the panel
// when the address names none.
async function showIssueFromUrl() {
  const ref = issueRefFromUrl();
  if (!ref) {
    if (panelIssueId !== null) await requestClosePanel();
    return;
  }
  const isWanted = (issue) => !issue.draft && sameIssueRef(issueRef(issue), ref);
  const tab = panelTabs.find((item) => item.id !== DRAFT_ID && isWanted(tabIssue(item)));
  if (tab) {
    switchToTab(tab.id);
    return;
  }
  try {
    openPanel(issues.find(isWanted) || (await fetchIssueFromRef(ref)));
  } catch (error) {
    showNotice(`Could not open ${displayRepo(ref.repo)}#${ref.number}: ${apiErrorMessage(error)}`, true);
  }
}

async function followIssueUrl() {
  if (document.body.dataset.page === "detail" && !detailVersion) return;
  issueUrlPauses++;
  try {
    await showIssueFromUrl();
  } finally {
    issueUrlPauses--;
  }
  // The panel may not have followed (unsaved changes kept, issue not found): the address then follows the panel.
  syncIssueUrl({ replace: true });
}

window.addEventListener("popstate", followIssueUrl);
