// Drag and drop between issues: nest a card or a subissue under another issue, insert it at a precise
// position, reorder siblings live, or take a subissue out of its parent by dropping it on a column.
// Loaded after subissues.js; it relies on globals declared in app.js, subissues.js and panel-settings.js.

const MAX_NESTING = 8;
// Nesting under a card or a row needs a short hold, so that crossing cards on the way to a column never nests by accident.
const NEST_DWELL_MS = 400;
document.documentElement.style.setProperty("--nest-dwell", `${NEST_DWELL_MS}ms`);
const EXPAND_DWELL_MS = 900;
const EDGE_ZONE = 0.3;
const SCROLL_EDGE = 48;
const SCROLL_STEP = 12;

const dropBoard = document.querySelector("#board");
let dragState = null;
let dragHint = null;
let relationBusy = false;

function beginDrag(kind, issue, node) {
  endDrag();
  dragState = { kind, issue, node, key: "", armed: false, timer: 0, expandTimer: 0, plan: null, shown: "", reordered: false, committed: false };
  dragHint = document.createElement("div");
  dragHint.className = "drag-hint";
  dragHint.hidden = true;
  document.body.append(dragHint);
}

// A small label stands for the dragged issue. It sits up and to the left of the pointer, so the tooltip
// (below and to the right) is never covered: the browser paints the drag image above the page.
function setDragGhost(event, issue) {
  const ghost = document.createElement("div");
  ghost.className = "drag-ghost";
  ghost.innerHTML = `${statusIconHtml(issue)}<span class="drag-ghost-title">#${issue.number} ${escapeHtml(issue.title)}</span>`;
  document.body.append(ghost);
  event.dataTransfer.setDragImage(ghost, ghost.offsetWidth + 8, ghost.offsetHeight + 8);
  setTimeout(() => ghost.remove(), 0);
}

function endDrag() {
  if (!dragState) return;
  const state = dragState;
  dragState = null;
  clearTimeout(state.timer);
  clearTimeout(state.expandTimer);
  clearIndicators();
  dragHint?.remove();
  dragHint = null;
  state.node?.classList.remove("dragging");
  if (state.reordered && !state.committed) refreshAllSubissueSections();
  else flushSubissueRefreshes();
}

function clearIndicators() {
  document.querySelectorAll(".drop-candidate, .drop-target, .drop-invalid").forEach((element) => {
    element.classList.remove("drop-candidate", "drop-target", "drop-invalid");
  });
  document.querySelectorAll(".drop-line").forEach((line) => line.remove());
}

function clearColumnState() {
  document.querySelectorAll(".column.drag-over").forEach((column) => column.classList.remove("drag-over"));
  removeDropIndicator();
}

function numberFromUrl(url) {
  return url.split("/").pop();
}

function parentByUrl(url) {
  return issues.find((item) => item.url === url) || { url };
}

// Levels from the top-level issue down to this one (a top-level issue is 1).
function issueDepth(issue) {
  let depth = 1;
  let current = issue;
  while (current.parent_issue_url && depth <= MAX_NESTING) {
    const parent = issues.find((item) => item.url === current.parent_issue_url);
    if (!parent) return depth + 1;
    depth += 1;
    current = parent;
  }
  return depth;
}

// Levels of the issue and its subissues (an issue without subissue is 1).
function subtreeHeight(issue, seen = new Set()) {
  if (seen.has(issue.id)) return 0;
  seen.add(issue.id);
  const heights = subIssuesOf(issue).map((child) => subtreeHeight(child, seen));
  return 1 + Math.max(0, ...heights);
}

function invalidReason(plan) {
  const source = dragState.issue;
  const parent = plan.parent;
  if (!parent) return "";
  if (parent.id === source.id) return "An issue can't be its own subissue.";
  if (descendantsOf(source).some((item) => item.id === parent.id)) return "An issue can't go into its own subissue.";
  if (issueDepth(parent) + subtreeHeight(source) > MAX_NESTING) return `Subissues can be nested ${MAX_NESTING} levels deep at most.`;
  if (plan.type === "nest" && source.parent_issue_url === parent.url) return `Already a subissue of #${parent.number}.`;
  return "";
}

function rowCandidate(event, row, rootId) {
  const drag = dragState;
  const node = row.parentElement;
  const group = node.parentElement;
  if (drag.kind === "subissue" && drag.node.contains(row)) return { type: "self", key: "self", el: row };
  const issue = findKnownIssue(Number(node.dataset.issueId));
  const parent = findKnownIssue(Number(group.dataset.parentId));
  if (!issue || !parent) return null;

  const rect = row.getBoundingClientRect();
  const ratio = (event.clientY - rect.top) / rect.height;
  if (ratio >= EDGE_ZONE && ratio <= 1 - EDGE_ZONE) {
    return { type: "nest", key: `nest:${issue.id}`, parent: issue, el: row, rootId };
  }
  const zone = ratio < EDGE_ZONE ? "before" : "after";
  if (drag.kind === "subissue" && drag.node.parentElement === group) {
    return { type: "reorder", key: "reorder", node, zone, el: row };
  }
  return { type: "insert", key: `insert:${issue.id}:${zone}`, parent, anchor: issue, node, zone, el: row, rootId };
}

function dragCandidate(event) {
  const target = event.target instanceof Element ? event.target : null;
  const card = target?.closest(".issue-card");
  if (!card) return null;
  const rootId = Number(card.dataset.issueId);
  if (dragState.kind === "card" && rootId === dragState.issue.id) return null;
  const row = target.closest(".subissue-row");
  if (row) return rowCandidate(event, row, rootId);
  const cardIssue = issues.find((item) => item.id === rootId);
  if (!cardIssue) return null;
  return { type: "nest", key: `nest:${cardIssue.id}`, parent: cardIssue, el: card, rootId };
}

function needsDwell(candidate) {
  return candidate.type !== "reorder" && candidate.type !== "self";
}

function startDwell(drag, candidate) {
  drag.timer = setTimeout(() => {
    drag.armed = true;
    if (dragState === drag && drag.lastEvent) evaluate(drag.lastEvent);
  }, NEST_DWELL_MS);
  const toggle = candidate.type === "nest" && candidate.el.classList.contains("issue-card") ? candidate.el.querySelector(".subissues-toggle") : null;
  if (toggle && candidate.el.querySelector(".subissue-list")?.hidden) {
    drag.expandTimer = setTimeout(() => toggle.click(), EXPAND_DWELL_MS);
  }
}

function liveReorder(drag, candidate) {
  const { node, zone } = candidate;
  if (zone === "before" && node.previousElementSibling !== drag.node) node.before(drag.node);
  else if (zone === "after" && node.nextElementSibling !== drag.node) node.after(drag.node);
  drag.reordered = true;
}

function hintText(candidate, active, reason, event) {
  const drag = dragState;
  const source = `#${drag.issue.number}`;
  if (candidate && !active) {
    return candidate.type === "nest" ? `Hold to add ${source} as a subissue of #${candidate.parent.number}` : `Hold to insert ${source} into #${candidate.parent.number}`;
  }
  if (reason) return reason;
  if (active?.type === "nest") return `Move ${source} under #${active.parent.number}`;
  if (active?.type === "insert") return `Insert ${source} in the subissues of #${active.parent.number}`;
  if (active) return "";
  const column = event.target instanceof Element ? event.target.closest(".column") : null;
  if (column && drag.kind === "subissue" && drag.issue.parent_issue_url) {
    return `Remove ${source} from #${numberFromUrl(drag.issue.parent_issue_url)} and move it to ${column.dataset.version}`;
  }
  return "";
}

function showIndicators(candidate, active, reason, event) {
  const drag = dragState;
  const text = hintText(candidate, active, reason, event);
  const signature = [candidate?.key, Boolean(active), reason, text, active?.type === "insert" ? active.zone : ""].join("|");
  if (dragHint) {
    dragHint.style.left = `${event.clientX + 16}px`;
    dragHint.style.top = `${event.clientY + 16}px`;
  }
  if (signature === drag.shown) return;
  drag.shown = signature;
  clearIndicators();

  if (candidate && !active) candidate.el.classList.add("drop-candidate");
  else if (reason) candidate.el.classList.add("drop-invalid");
  else if (active?.type === "nest") active.el.classList.add("drop-target");
  else if (active?.type === "insert") {
    const line = document.createElement("div");
    line.className = "drop-line";
    if (active.zone === "before") active.node.before(line);
    else active.node.after(line);
  }
  if (active) clearColumnState();

  if (dragHint) {
    dragHint.textContent = text;
    dragHint.hidden = !text;
    dragHint.classList.toggle("invalid", Boolean(reason));
  }
}

// Works out what a drop at this pointer position would do, and shows it.
// Returns the active candidate (null while the pointer is not on a target, or has not held long enough).
function evaluate(event) {
  const drag = dragState;
  drag.lastEvent = event;
  const candidate = dragCandidate(event);
  const key = candidate ? candidate.key : "";
  if (key !== drag.key) {
    clearTimeout(drag.timer);
    clearTimeout(drag.expandTimer);
    drag.key = key;
    drag.armed = false;
    if (candidate && needsDwell(candidate)) startDwell(drag, candidate);
  }
  if (candidate && event.shiftKey) drag.armed = true;
  const active = candidate && (drag.armed || !needsDwell(candidate)) ? candidate : null;
  if (active?.type === "reorder") liveReorder(drag, active);
  const reason = active ? invalidReason(active) : "";
  drag.plan = active && !reason ? active : null;
  showIndicators(candidate, active, reason, event);
  return { active, reason };
}

function autoScroll(event) {
  const target = event.target instanceof Element ? event.target : null;
  const list = target?.closest(".issue-list");
  if (list) {
    const rect = list.getBoundingClientRect();
    if (event.clientY < rect.top + SCROLL_EDGE) list.scrollTop -= SCROLL_STEP;
    else if (event.clientY > rect.bottom - SCROLL_EDGE) list.scrollTop += SCROLL_STEP;
  }
  const boardRect = dropBoard.getBoundingClientRect();
  if (event.clientX < boardRect.left + SCROLL_EDGE) dropBoard.scrollLeft -= SCROLL_STEP;
  else if (event.clientX > boardRect.right - SCROLL_EDGE) dropBoard.scrollLeft += SCROLL_STEP;
}

dropBoard.addEventListener("dragover", (event) => {
  if (!dragState) return;
  autoScroll(event);
  const { active, reason } = evaluate(event);
  if (!active) return;
  event.stopPropagation();
  if (reason) {
    event.dataTransfer.dropEffect = "none";
    return;
  }
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
}, true);

dropBoard.addEventListener("drop", (event) => {
  if (!dragState) return;
  const { active, reason } = evaluate(event);
  if (!active) return;
  event.preventDefault();
  event.stopPropagation();
  const drag = dragState;
  if (reason) {
    endDrag();
    return;
  }
  if (active.type === "reorder" || active.type === "self") {
    if (drag.reordered) {
      drag.committed = true;
      commitReorder(drag.node.closest(".subissues"), drag.node);
    }
  } else if (active.type === "nest") {
    nestIssue(drag.issue, active.parent, null, active.rootId);
  } else {
    nestIssue(drag.issue, active.parent, { [active.zone === "before" ? "before_id" : "after_id"]: active.anchor.id }, active.rootId);
  }
  endDrag();
}, true);

function adjustSummary(parentUrl, total, completed) {
  const target = issues.find((item) => item.url === parentUrl);
  if (!target) return;
  const children = subIssuesOf(target);
  const before = target.sub_issues_summary || { total: children.length, completed: children.filter(isClosed).length };
  const next = { total: Math.max(0, before.total + total), completed: Math.max(0, before.completed + completed) };
  next.percent_completed = next.total ? Math.round((next.completed / next.total) * 100) : 0;
  target.sub_issues_summary = next;
}

// Mirrors a parent change on the loaded issues; the cached subissue orders are reloaded from GitHub when needed.
function changeParentLocal(issue, oldUrl, newUrl) {
  const done = isClosed(issue) ? 1 : 0;
  if (oldUrl) adjustSummary(oldUrl, -1, -done);
  if (newUrl) adjustSummary(newUrl, 1, done);
  for (const item of [issues.find((entry) => entry.id === issue.id), issue]) {
    if (item) item.parent_issue_url = newUrl;
  }
  subIssueOrders.clear();
}

function redrawAfterRelationChange() {
  saveIssuesCache();
  renderBoard();
  summary.textContent = summaryText();
  // Forces the side panel to reload the relationships of the issue it shows.
  panelExtras.key = "";
  refreshPanel();
}

async function nestIssue(issue, parent, position = null, rootId = null) {
  if (!accessToken) {
    openAuthDialog();
    return;
  }
  if (relationBusy) return;
  relationBusy = true;
  notice.hidden = true;
  const oldUrl = issue.parent_issue_url || null;
  let linked = false;
  try {
    if (oldUrl !== parent.url) {
      await sendRelationRequest("POST", `${parent.url}/sub_issues`, { sub_issue_id: issue.id, replace_parent: true });
      changeParentLocal(issue, oldUrl, parent.url);
      linked = true;
    }
    if (position) await sendRelationRequest("PATCH", `${parent.url}/sub_issues/priority`, { sub_issue_id: issue.id, ...position });
  } catch (error) {
    showNotice(`Could not move #${issue.number} under #${numberFromUrl(parent.url)}: ${apiErrorMessage(error)}`, true);
    if (!linked) {
      relationBusy = false;
      return;
    }
  }
  relationBusy = false;
  if (rootId) expandedSubissues.add(rootId);
  redrawAfterRelationChange();
  const undo = oldUrl ? () => nestIssue(issue, parentByUrl(oldUrl)) : () => unnestIssue(issue, parent.url);
  if (notice.hidden) showUndo(`Moved #${issue.number} under #${numberFromUrl(parent.url)}.`, undo);
}

async function unnestIssue(issue, parentUrl) {
  if (relationBusy) return false;
  relationBusy = true;
  notice.hidden = true;
  try {
    await sendRelationRequest("DELETE", `${parentUrl}/sub_issue`, { sub_issue_id: issue.id });
  } catch (error) {
    showNotice(`Could not remove #${issue.number} from #${numberFromUrl(parentUrl)}: ${apiErrorMessage(error)}`, true);
    return false;
  } finally {
    relationBusy = false;
  }
  changeParentLocal(issue, parentUrl, null);
  redrawAfterRelationChange();
  return true;
}

// Dropping on a column moves the issue there; a subissue taken from a list also leaves its parent.
async function dropOnColumn(issue, version) {
  const fromList = dragState && dragState.kind === "subissue" && dragState.issue.id === issue.id;
  const parentUrl = issue.parent_issue_url;
  if (!accessToken || !fromList || !parentUrl) {
    await moveIssue(issue, version);
    return;
  }
  if (!(await unnestIssue(issue, parentUrl))) return;
  showUndo(`Removed #${issue.number} from #${numberFromUrl(parentUrl)}.`, () => nestIssue(issue, parentByUrl(parentUrl)));
  await moveIssue(issues.find((item) => item.id === issue.id) || issue, version, { restoreParent: parentUrl });
}
