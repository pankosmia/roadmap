// Linked pull requests (Development): state colors, the icon shown on cards and in the Done dialog, and its popover.
// Loaded before panel-settings.js and app.js; it relies on globals declared there (accessToken, issues, githubRequest…).

const PULL_FIELDS = "number title url state isDraft repository { nameWithOwner }";
const PULL_BATCH_SIZE = 40;
const PULL_BATCH_PARALLEL = 3;

// The color classes follow the issue status colors; a closed pull request that was not merged is red.
const PULL_STATES = {
  MERGED: { icon: "merge", text: "Merged", className: "pr-merged", rank: 3 },
  OPEN: { icon: "merge_type", text: "Open", className: "pr-open", rank: 2 },
  DRAFT: { icon: "merge_type", text: "Draft", className: "pr-draft", rank: 1 },
  CLOSED: { icon: "merge_type", text: "Closed", className: "pr-closed", rank: 0 }
};

let pullsRun = 0;
let developmentPopover = null;

function pullState(pull) {
  return PULL_STATES[pull.state] || PULL_STATES.OPEN;
}

function pullFromNode(node) {
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    state: node.isDraft && node.state === "OPEN" ? "DRAFT" : node.state,
    repo: node.repository.nameWithOwner
  };
}

// One icon stands for all pull requests of an issue: merged wins over open, then draft, then closed.
function summaryPullState(pulls) {
  return pulls.map(pullState).reduce((best, state) => (state.rank > best.rank ? state : best));
}

function pullRowHtml(pull) {
  const state = pullState(pull);
  return `
        <li class="relation-row">
          <md-icon class="${state.className}" title="${state.text}">${state.icon}</md-icon>
          <a href="${escapeHtml(pull.url)}" target="_blank" rel="noopener"><span class="relation-title">${escapeHtml(pull.title)}</span>
            <span class="relation-ref">${escapeHtml(pull.repo)}#${pull.number} · ${state.text}</span></a>
        </li>`;
}

function developmentTriggerHtml(issue) {
  const pulls = issue.pulls;
  if (!pulls || pulls.length === 0) return "";
  const state = summaryPullState(pulls);
  const label = `${pulls.length} linked pull ${pulls.length === 1 ? "request" : "requests"} · ${state.text}`;
  return `<button type="button" class="dev-trigger ${state.className}" data-issue-id="${issue.id}" aria-haspopup="dialog" title="${label}" aria-label="${label}"><span class="dev-icon"><md-icon>${state.icon}</md-icon><span class="dev-count">${pulls.length}</span></span></button>`;
}

function developmentSlotHtml(issue) {
  return `<span class="dev-slot" data-html="${escapeHtml(developmentTriggerHtml(issue))}">${developmentTriggerHtml(issue)}</span>`;
}

// Updates the icons already on screen (cards) once pull requests are known, without rebuilding the board.
function refreshDevelopmentIcons() {
  const byId = new Map(issues.map((issue) => [String(issue.id), issue]));
  for (const card of document.querySelectorAll(".issue-card[data-issue-id]")) {
    const slot = card.querySelector(".dev-slot");
    const issue = byId.get(card.dataset.issueId);
    if (!slot || !issue) continue;
    const html = developmentTriggerHtml(issue);
    if (slot.dataset.html === html) continue;
    slot.dataset.html = html;
    slot.innerHTML = html;
  }
  if (developmentPopover && !developmentPopover.trigger.isConnected) closeDevelopmentPopover(false);
  refreshDoneDialog();
}

function setIssuePulls(issueId, pulls) {
  const issue = issues.find((item) => item.id === issueId);
  if (issue) issue.pulls = pulls;
}

function clearIssuePulls() {
  pullsRun += 1;
  for (const issue of issues) delete issue.pulls;
  refreshDevelopmentIcons();
}

function pullsBatchQuery(batch) {
  const fields = batch.map((issue, index) => {
    const [owner, name] = repoOf(issue);
    return `i${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
      issue(number: ${issue.number}) { closedByPullRequestsReferences(first: 25, includeClosedPrs: true) { nodes { ${PULL_FIELDS} } } }
    }`;
  });
  return `query { ${fields.join("\n")} }`;
}

async function loadPullBatch(batch) {
  const result = await githubRequest(
    `${API_ROOT}/graphql`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: pullsBatchQuery(batch) }) },
    accessToken
  );
  // Repositories that cannot be read come back as null with an error; the other issues are still used.
  if (!result.data) throw new Error(result.errors?.[0]?.message || "No data returned.");
  batch.forEach((issue, index) => {
    const nodes = result.data[`i${index}`]?.issue?.closedByPullRequestsReferences?.nodes;
    if (nodes) setIssuePulls(issue.id, nodes.map(pullFromNode));
  });
}

// Fetches linked pull requests for all issues in a few batched GraphQL requests (GitHub needs a token for this).
async function loadPullRequests({ force = false } = {}) {
  if (!accessToken) return;
  const run = ++pullsRun;
  const targets = issues.filter((issue) => force || !issue.pulls);
  const batches = [];
  for (let start = 0; start < targets.length; start += PULL_BATCH_SIZE) batches.push(targets.slice(start, start + PULL_BATCH_SIZE));
  let next = 0;
  let failure = null;
  const worker = async () => {
    while (next < batches.length && run === pullsRun && !failure) {
      try {
        await loadPullBatch(batches[next++]);
      } catch (error) {
        failure = error;
        return;
      }
      if (run === pullsRun) refreshDevelopmentIcons();
    }
  };
  await Promise.all(Array.from({ length: Math.min(PULL_BATCH_PARALLEL, batches.length) }, worker));
  if (run !== pullsRun) return;
  saveIssuesCache();
  if (failure) showNotice(`Linked pull requests could not be loaded: ${apiErrorMessage(failure)}`, true);
}

function closeDevelopmentPopover(restoreFocus = true) {
  if (!developmentPopover) return;
  const { element, trigger, onOutside, onKey, onViewport } = developmentPopover;
  document.removeEventListener("pointerdown", onOutside, true);
  document.removeEventListener("keydown", onKey, true);
  window.removeEventListener("scroll", onViewport, true);
  window.removeEventListener("resize", onViewport);
  element.remove();
  developmentPopover = null;
  if (restoreFocus && trigger.isConnected) trigger.focus();
}

function positionDevelopmentPopover(element, trigger) {
  const rect = trigger.getBoundingClientRect();
  const width = Math.min(360, window.innerWidth - 16);
  const below = window.innerHeight - rect.bottom - 12;
  const above = rect.top - 12;
  const openAbove = below < 200 && above > below;
  element.style.width = `${width}px`;
  element.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  element.style.top = openAbove ? "auto" : `${rect.bottom + 4}px`;
  element.style.bottom = openAbove ? `${window.innerHeight - rect.top + 4}px` : "auto";
  element.style.maxHeight = `${Math.min(360, openAbove ? above : below)}px`;
}

function openDevelopmentPopover(trigger) {
  const issue = issues.find((item) => String(item.id) === trigger.dataset.issueId);
  if (!issue || !issue.pulls || issue.pulls.length === 0) return;
  closeDevelopmentPopover(false);
  const element = document.createElement("div");
  element.className = "dev-popover";
  element.setAttribute("popover", "manual");
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-label", "Linked pull requests");
  element.innerHTML = `<h4>Linked pull requests</h4><ul class="relation-list">${issue.pulls.map(pullRowHtml).join("")}</ul>`;
  // Inside a modal dialog, the popover must be part of the dialog content or it would be inert.
  (trigger.closest('[slot="content"]') || document.body).append(element);
  element.showPopover();
  positionDevelopmentPopover(element, trigger);

  const state = { element, trigger };
  state.onOutside = (event) => {
    if (!element.contains(event.target) && !event.target.closest?.(".dev-trigger")) closeDevelopmentPopover(false);
  };
  state.onKey = (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    closeDevelopmentPopover();
  };
  state.onViewport = (event) => {
    if (!element.contains(event.target)) closeDevelopmentPopover(false);
  };
  document.addEventListener("pointerdown", state.onOutside, true);
  document.addEventListener("keydown", state.onKey, true);
  window.addEventListener("scroll", state.onViewport, true);
  window.addEventListener("resize", state.onViewport);
  developmentPopover = state;
}

document.addEventListener("click", (event) => {
  const trigger = event.target.closest?.(".dev-trigger");
  if (!trigger) return;
  if (developmentPopover?.trigger === trigger) closeDevelopmentPopover();
  else openDevelopmentPopover(trigger);
});
