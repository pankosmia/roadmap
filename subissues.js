// Subissues on cards: progress bar, nested list in GitHub's manual order, drag-and-drop reordering
// and inline creation. Loaded before app.js; it relies on globals declared in app.js and panel-settings.js.

const SUBISSUE_MAX_DEPTH = 5;

const expandedSubissues = new Set();
// Parent issue id -> its subissues in the order GitHub stores them (the manual priority).
const subIssueOrders = new Map();
const subIssueLoads = new Map();
const reorderQueues = new Map();
const pendingRefreshes = new Set();

function liveIssue(issue) {
  return issues.find((item) => item.id === issue.id) || issue;
}

function hasSubIssues(issue) {
  return (issue.sub_issues_summary?.total || 0) > 0 || subIssuesOf(issue).length > 0;
}

function orderedSubIssues(parent) {
  const loaded = subIssueOrders.get(parent.id);
  if (!loaded) return subIssuesOf(parent);
  const known = new Map(issues.map((item) => [item.id, item]));
  return loaded.map((item) => known.get(item.id) || item);
}

function findKnownIssue(id) {
  const local = issues.find((item) => item.id === id);
  if (local) return local;
  for (const list of subIssueOrders.values()) {
    const found = list.find((item) => item.id === id);
    if (found) return found;
  }
  return null;
}

function subIssueRef(subIssue, parent) {
  const [owner, name] = repoOf(subIssue);
  const [parentOwner, parentName] = repoOf(parent);
  const sameRepo = owner === parentOwner && name === parentName;
  return sameRepo ? `#${subIssue.number}` : `${owner}/${name}#${subIssue.number}`;
}

async function fetchSubIssueTree(parent, path, depth = 0) {
  const url = `${issueApiUrl(repoOf(parent).join("/"), parent.number)}/sub_issues`;
  const children = await fetchAllPages(url);
  subIssueOrders.set(parent.id, children);
  if (depth + 1 >= SUBISSUE_MAX_DEPTH) return;
  const nextPath = new Set(path).add(parent.id);
  const withChildren = children.filter((child) => !nextPath.has(child.id) && hasSubIssues(liveIssue(child)));
  await Promise.all(withChildren.map((child) => fetchSubIssueTree(liveIssue(child), nextPath, depth + 1)));
}

function loadSubIssueOrders(root) {
  if (subIssueLoads.has(root.id)) return subIssueLoads.get(root.id);
  const load = fetchSubIssueTree(root, new Set())
    .then(() => refreshSubissueSections(root.id))
    .catch((error) => showNotice(`Could not load the subissues of ${repoOf(root)[1]}#${root.number}: ${apiErrorMessage(error)}`, true))
    .finally(() => subIssueLoads.delete(root.id));
  subIssueLoads.set(root.id, load);
  return load;
}

// The list is not rebuilt while it is being dragged; the refresh runs when the drag ends.
function refreshSubissueSections(rootId) {
  if (dragState) {
    pendingRefreshes.add(rootId);
    return;
  }
  for (const section of document.querySelectorAll(`.subissues[data-issue-id="${rootId}"]`)) {
    if (!section.querySelector(".subissue-list").hidden) renderSubissueList(section);
  }
}

function refreshAllSubissueSections() {
  pendingRefreshes.clear();
  for (const section of document.querySelectorAll(".subissues")) {
    if (!section.querySelector(".subissue-list").hidden) renderSubissueList(section);
  }
}

function flushSubissueRefreshes() {
  const ids = [...pendingRefreshes];
  pendingRefreshes.clear();
  ids.forEach(refreshSubissueSections);
}

function subIssueHandleHtml(subIssue) {
  const label = `Move #${subIssue.number}: drag it, or use the up and down arrow keys to reorder`;
  return `<span class="subissue-handle" role="button" tabindex="0" draggable="true" title="Drag to move or reorder" aria-label="${escapeHtml(label)}"><md-icon>drag_indicator</md-icon></span>`;
}

function createSubIssueNode(parent, subIssue, path, canDrag) {
  const node = document.createElement("div");
  node.className = "subissue-node";
  node.dataset.issueId = subIssue.id;

  const row = document.createElement("div");
  row.className = "subissue-row";
  if (canDrag) row.insertAdjacentHTML("beforeend", subIssueHandleHtml(subIssue));
  const item = document.createElement("md-list-item");
  item.type = "button";
  item.className = isClosed(subIssue) ? "subissue-item is-closed" : "subissue-item";
  item.innerHTML = `
    <span slot="start" class="subissue-status">${statusIconHtml(subIssue)}</span>
    <div slot="headline">${escapeHtml(subIssue.title)}</div>
    <div slot="supporting-text">${escapeHtml(subIssueRef(subIssue, parent))}</div>
    ${avatarsHtml(subIssue, 20, "end")}
  `;
  item.addEventListener("click", () => openPanel(subIssue));
  row.append(item);
  node.append(row);

  const nextPath = new Set(path).add(subIssue.id);
  if (nextPath.size < SUBISSUE_MAX_DEPTH) {
    const children = renderSubIssueGroup(subIssue, nextPath);
    if (children) node.append(children);
  }
  return node;
}

// Returns a container with the nodes of one group of siblings, or null when the parent has no subissue to show.
function renderSubIssueGroup(parent, path, container = document.createElement("div")) {
  const children = orderedSubIssues(parent).filter((child) => !path.has(child.id));
  if (children.length === 0) return null;
  container.dataset.parentId = parent.id;
  const canDrag = Boolean(accessToken);
  if (container.className === "") container.className = "subissue-children";
  container.prepend(...children.map((child) => createSubIssueNode(parent, child, path, canDrag)));
  return container;
}

function renderSubissueList(section) {
  const root = issues.find((item) => item.id === Number(section.dataset.issueId));
  if (!root) return;
  const list = section.querySelector(".subissue-list");
  list.querySelectorAll(":scope > .subissue-node").forEach((node) => node.remove());
  list.dataset.parentId = root.id;
  renderSubIssueGroup(root, new Set([root.id]), list);
}

function createSubissues(issue) {
  const progress = subIssueProgress(issue);
  const expanded = expandedSubissues.has(issue.id);
  const section = document.createElement("div");
  section.className = "subissues";
  section.dataset.issueId = issue.id;
  section.innerHTML = `
    <div class="subissues-head">
      <md-filled-tonal-button class="subissues-toggle" type="button" trailing-icon aria-expanded="${expanded}">
        Subissues (${progress ? `${progress.done}/${progress.total}` : 0})
        <md-icon slot="icon">${expanded ? "expand_less" : "expand_more"}</md-icon>
      </md-filled-tonal-button>
      ${progress ? `<md-linear-progress class="subissues-progress" aria-hidden="true" max="1" value="${progress.done / progress.total}"></md-linear-progress>` : ""}
    </div>
    <div class="subissue-list" role="group" aria-label="Subissues" ${expanded ? "" : "hidden"}></div>
  `;
  const toggle = section.querySelector(".subissues-toggle");
  const list = section.querySelector(".subissue-list");
  list.append(createAddRow(issue.id));
  renderSubissueList(section);
  setupReorder(section, list);

  toggle.addEventListener("click", () => {
    const open = list.hidden;
    list.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.querySelector("md-icon").textContent = open ? "expand_less" : "expand_more";
    if (open) {
      expandedSubissues.add(issue.id);
      loadSubIssueOrders(liveIssue(issue));
    } else {
      expandedSubissues.delete(issue.id);
    }
  });
  if (expanded && !subIssueOrders.has(issue.id)) loadSubIssueOrders(liveIssue(issue));
  return section;
}

// A drag that starts on a subissue row (not only on its handle) moves that subissue, never the whole parent card.
let pressedSubissueNode = null;
document.addEventListener("pointerdown", (event) => {
  pressedSubissueNode = event.target instanceof Element ? event.target.closest(".subissue-node") : null;
}, true);

function pressedSubissue(card) {
  return pressedSubissueNode && card.contains(pressedSubissueNode) ? pressedSubissueNode : null;
}

function startSubissueDrag(event, node) {
  const subIssue = findKnownIssue(Number(node.dataset.issueId));
  if (!subIssue) {
    event.preventDefault();
    return;
  }
  beginDrag("subissue", subIssue, node);
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", String(subIssue.id));
  setDragGhost(event, subIssue);
  requestAnimationFrame(() => node.classList.add("dragging"));
}

// Reordering: the handle starts a drag (see nesting.js for the drop targets and the live reorder).
function setupReorder(section, list) {
  list.addEventListener("dragstart", (event) => {
    const handle = event.target instanceof Element ? event.target.closest(".subissue-handle") : null;
    if (!handle) return;
    event.stopPropagation();
    startSubissueDrag(event, handle.closest(".subissue-node"));
  });

  list.addEventListener("dragend", endDrag);

  list.addEventListener("keydown", (event) => {
    const handle = event.target instanceof Element ? event.target.closest(".subissue-handle") : null;
    if (!handle || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    event.stopPropagation();
    const node = handle.closest(".subissue-node");
    const sibling = event.key === "ArrowUp" ? node.previousElementSibling : node.nextElementSibling;
    if (!sibling || !sibling.classList.contains("subissue-node")) return;
    if (event.key === "ArrowUp") sibling.before(node);
    else sibling.after(node);
    handle.focus();
    commitReorder(section, node);
  });
}

function commitReorder(section, node) {
  const group = node.parentElement;
  const parent = findKnownIssue(Number(group.dataset.parentId));
  if (!parent) return;
  const ids = [...group.children].filter((child) => child.classList.contains("subissue-node")).map((child) => Number(child.dataset.issueId));
  reorderSubIssues(section, parent, ids, Number(node.dataset.issueId));
}

function reorderSubIssues(section, parent, ids, movedId) {
  const previous = subIssueOrders.get(parent.id);
  if (!previous) return;
  const byId = new Map(previous.map((item) => [item.id, item]));
  const next = ids.map((id) => byId.get(id)).filter(Boolean);
  if (next.length !== previous.length) {
    renderSubissueList(section);
    return;
  }
  if (next.every((item, index) => item.id === previous[index].id)) return;
  subIssueOrders.set(parent.id, next);

  const index = ids.indexOf(movedId);
  const body = index > 0 ? { sub_issue_id: movedId, after_id: ids[index - 1] } : { sub_issue_id: movedId, before_id: ids[1] };
  const url = `${issueApiUrl(repoOf(parent).join("/"), parent.number)}/sub_issues/priority`;
  const run = (reorderQueues.get(parent.id) || Promise.resolve()).then(async () => {
    try {
      await sendRelationRequest("PATCH", url, body);
    } catch (error) {
      showNotice(`Could not reorder the subissues of ${repoOf(parent)[1]}#${parent.number}: ${apiErrorMessage(error)}`, true);
      // Reload the real order from GitHub once the pending reorders are done.
      subIssueOrders.delete(parent.id);
      const root = issues.find((item) => item.id === Number(section.dataset.issueId));
      if (root) await loadSubIssueOrders(root);
    }
  });
  reorderQueues.set(parent.id, run);
}

// Opens the Create issue panel with this issue as the parent.
function createAddRow(parentId) {
  const wrap = document.createElement("div");
  wrap.className = "subissue-add";
  wrap.innerHTML = `
    <md-list-item type="button" class="subissue-item subissue-add-button">
      <md-icon slot="start">add</md-icon>
      <div slot="headline">Add subissue</div>
    </md-list-item>
  `;
  wrap.querySelector(".subissue-add-button").addEventListener("click", () => {
    const parent = issues.find((item) => item.id === parentId);
    if (parent) openNewIssuePanel(parent);
  });
  return wrap;
}
