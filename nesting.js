// Drag and drop between issues: nest a card or a subissue under another issue, insert it at a precise
// position, reorder siblings live, or take a subissue out of its parent by dropping it on a column.
// Loaded after subissues.js; it relies on globals declared in app.js, subissues.js and panel-settings.js.

const MAX_NESTING = 8;
// Nesting under a card or a row needs a short hold, so that crossing cards on the way to a column never nests by accident.
const NEST_DWELL_MS = 400;
document.documentElement.style.setProperty("--nest-dwell", `${NEST_DWELL_MS}ms`);
const EXPAND_DWELL_MS = 900;
const EDGE_ZONE = 0.3;
// Among siblings the edges (reorder) are larger and the middle (nest into a sibling) is a narrow, deliberate zone.
const SIBLING_EDGE_ZONE = 0.4;
// Gaps between rows (and the gap under the Subissues button) belong to the nearest row within this distance.
const MAGNET_PX = 14;
const SCROLL_EDGE = 48;
const SCROLL_STEP = 12;

const dropBoard = document.querySelector("#board");
let dragState = null;
let dragHint = null;
let relationBusy = false;

function beginDrag(kind, issue, node) {
  endDrag();
  const rootId = Number(node?.closest(".issue-card")?.dataset.issueId) || 0;
  dragState = {
    kind, issue, node, rootId, key: "", armed: false, timer: 0, expandTimer: 0,
    plan: null, shown: "", line: null, lineTarget: null,
  };
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
  flushSubissueRefreshes();
}

function clearIndicators() {
  document.querySelectorAll(".drop-candidate, .drop-target, .drop-invalid").forEach((element) => {
    element.classList.remove("drop-candidate", "drop-target", "drop-invalid");
  });
  document.querySelectorAll(".drop-line").forEach((line) => line.remove());
  if (dragState) dragState.line = null;
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

// An insertion between two rows is always expressed as "before the next row" (or "before the first child"),
// so the same place never has two different targets that the pointer could flip between.
function insertCandidate(parent, issue, node, zone, el, rootId) {
  if (zone === "after") {
    const firstChild = node.querySelector(":scope > .subissue-children > .subissue-node");
    const next = firstChild || node.nextElementSibling;
    if (next && next.classList.contains("subissue-node")) {
      const nextIssue = findKnownIssue(Number(next.dataset.issueId));
      if (nextIssue) return insertCandidate(firstChild ? issue : parent, nextIssue, next, "before", el, rootId);
    }
  }
  return { type: "insert", key: `insert:${issue.id}:${zone}`, parent, anchor: issue, node, zone, el, rootId };
}

// forcedZone is set when the pointer is in a gap next to the row instead of on it.
function rowCandidate(event, row, rootId, forcedZone = "") {
  const drag = dragState;
  const node = row.parentElement;
  const group = node.parentElement;
  if (drag.kind === "subissue" && drag.node.contains(row)) return { type: "self", key: "self", el: row };
  const issue = findKnownIssue(Number(node.dataset.issueId));
  const parent = findKnownIssue(Number(group.dataset.parentId));
  if (!issue || !parent) return null;

  const sameGroup = drag.kind === "subissue" && drag.node.parentElement === group;
  let zone = forcedZone;
  if (!zone) {
    const edge = sameGroup ? SIBLING_EDGE_ZONE : EDGE_ZONE;
    const rect = row.getBoundingClientRect();
    const ratio = (event.clientY - rect.top) / rect.height;
    if (ratio >= edge && ratio <= 1 - edge) {
      return { type: "nest", key: `nest:${issue.id}`, parent: issue, el: row, rootId };
    }
    zone = ratio < edge ? "before" : "after";
  }
  const target = insertCandidate(parent, issue, node, zone, row, rootId);
  // Between siblings it is a reorder. The bottom edge of a row that has subissues points into that row's list instead.
  if (sameGroup && target.parent.id === parent.id) return { ...target, type: "reorder", key: `reorder:${target.anchor.id}:${target.zone}` };
  return target;
}

function nearestRowCandidate(event, list, rootId) {
  let best = null;
  let bestDistance = MAGNET_PX + 1;
  for (const row of list.querySelectorAll(".subissue-row")) {
    const rect = row.getBoundingClientRect();
    const distance = event.clientY < rect.top ? rect.top - event.clientY : event.clientY - rect.bottom;
    if (distance >= 0 && distance < bestDistance) {
      best = { row, zone: event.clientY < rect.top ? "before" : "after" };
      bestDistance = distance;
    }
  }
  return best ? rowCandidate(event, best.row, rootId, best.zone) : null;
}

function dragCandidate(event) {
  const target = event.target instanceof Element ? event.target : null;
  const card = target?.closest(".issue-card");
  if (!card) return null;
  const rootId = Number(card.dataset.issueId);
  if (dragState.kind === "card" && rootId === dragState.issue.id) return null;
  const row = target.closest(".subissue-row");
  if (row) return rowCandidate(event, row, rootId);
  const list = target.closest(".subissue-list");
  if (list && !list.hidden) {
    const near = nearestRowCandidate(event, list, rootId);
    if (near) return near;
  }
  // Elsewhere on its own parent card, a dragged subissue stays where it is (leaving the card is how it gets out).
  if (dragState.kind === "subissue" && rootId === dragState.rootId) return { type: "hold", key: "hold", el: card, rootId };
  const cardIssue = issues.find((item) => item.id === rootId);
  if (!cardIssue) return null;
  return { type: "nest", key: `nest:${cardIssue.id}`, parent: cardIssue, el: card, rootId };
}

function needsDwell(candidate) {
  // Pointing at a subissue row is deliberate and arms at once; resting on a whole card needs the short hold.
  return candidate.type === "nest" && candidate.el.classList.contains("issue-card");
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

function hintText(candidate, active, reason, event) {
  const drag = dragState;
  const source = `#${drag.issue.number}`;
  if (candidate && !active) {
    return candidate.type === "nest" ? `Hold to add ${source} as a subissue of #${candidate.parent.number}` : `Hold to insert ${source} into #${candidate.parent.number}`;
  }
  if (reason) return reason;
  if (active?.type === "nest") return `Move ${source} under #${active.parent.number}`;
  if (active?.type === "insert") return `Insert ${source} in the subissues of #${active.parent.number}`;
  if (active?.type === "reorder") return `Put ${source} here`;
  if (active) return "";
  const column = event.target instanceof Element ? event.target.closest(".column") : null;
  if (column && drag.kind === "subissue" && drag.issue.parent_issue_url) {
    return `Remove ${source} from #${numberFromUrl(drag.issue.parent_issue_url)} and move it to ${column.dataset.version}`;
  }
  return "";
}

// The insertion line floats above the list instead of sitting in it, so showing it never moves the rows under the pointer.
function positionDropLine(drag) {
  if (!drag.line) return;
  const { node, zone } = drag.lineTarget;
  const rect = node.getBoundingClientRect();
  drag.line.style.left = `${rect.left + 8}px`;
  drag.line.style.width = `${Math.max(0, rect.width - 16)}px`;
  drag.line.style.top = `${(zone === "before" ? rect.top : rect.bottom) - 2}px`;
}

function showIndicators(candidate, active, reason, event) {
  const drag = dragState;
  const text = hintText(candidate, active, reason, event);
  const signature = [candidate?.key, Boolean(active), reason, text].join("|");
  if (dragHint) {
    dragHint.style.left = `${event.clientX + 16}px`;
    dragHint.style.top = `${event.clientY + 16}px`;
  }
  positionDropLine(drag);
  if (signature === drag.shown) return;
  drag.shown = signature;
  clearIndicators();

  if (candidate && !active) candidate.el.classList.add("drop-candidate");
  else if (reason) candidate.el.classList.add("drop-invalid");
  else if (active?.type === "nest") active.el.classList.add("drop-target");
  else if (active?.type === "insert" || active?.type === "reorder") {
    drag.line = document.createElement("div");
    drag.line.className = "drop-line";
    drag.lineTarget = active;
    document.body.append(drag.line);
    positionDropLine(drag);
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
  const reason = active ? invalidReason(active) : "";
  drag.plan = active && !reason ? active : null;
  // Over its own parent card a subissue never falls back to the column drop, which would take it out of its parent.
  const hold = !active && Boolean(candidate) && drag.kind === "subissue" && candidate.rootId === drag.rootId;
  if (hold) clearColumnState();
  showIndicators(candidate, active, reason, event);
  return { active, reason, hold };
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
  const { active, reason, hold } = evaluate(event);
  if (!active && !hold) return;
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
  const { active, reason, hold } = evaluate(event);
  if (!active && !hold) return;
  event.preventDefault();
  event.stopPropagation();
  const drag = dragState;
  if (reason) {
    endDrag();
    return;
  }
  // Over itself, or over its own parent card, a subissue stays where it is.
  if (active && active.type === "reorder") {
    if (active.node !== drag.node) active.node[active.zone === "before" ? "before" : "after"](drag.node);
    commitReorder(drag.node.closest(".subissues"), drag.node);
  } else if (active && active.type === "nest") {
    nestIssue(drag.issue, active.parent, null, active.rootId);
  } else if (active && active.type === "insert") {
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

// Forgets the cached order of a parent and of the parents above it, so that it is fetched again.
function forgetOrders(parentUrl) {
  let current = issues.find((item) => item.url === parentUrl);
  if (!current) {
    subIssueOrders.clear();
    return;
  }
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    subIssueOrders.delete(current.id);
    current = issues.find((item) => item.url === current.parent_issue_url);
  }
}

// Keeps the cached orders in step with a move, so that the lists show the new order without waiting for GitHub.
function moveInOrders(issue, oldUrl, newUrl, position) {
  const oldParent = oldUrl && issues.find((item) => item.url === oldUrl);
  const oldOrder = oldParent && subIssueOrders.get(oldParent.id);
  if (oldOrder) subIssueOrders.set(oldParent.id, oldOrder.filter((item) => item.id !== issue.id));
  const newParent = newUrl && issues.find((item) => item.url === newUrl);
  const newOrder = newParent && subIssueOrders.get(newParent.id);
  if (!newOrder) return;
  const next = newOrder.filter((item) => item.id !== issue.id);
  let index = next.length;
  if (position) {
    const at = next.findIndex((item) => item.id === (position.before_id ?? position.after_id));
    if (at >= 0) index = position.before_id ? at : at + 1;
  }
  next.splice(index, 0, { ...issue, parent_issue_url: newUrl });
  subIssueOrders.set(newParent.id, next);
}

// Mirrors a parent change on the loaded issues and in the cached subissue orders.
function changeParentLocal(issue, oldUrl, newUrl, position = null) {
  const done = isClosed(issue) ? 1 : 0;
  if (oldUrl) adjustSummary(oldUrl, -1, -done);
  if (newUrl) adjustSummary(newUrl, 1, done);
  for (const item of [issues.find((entry) => entry.id === issue.id), issue]) {
    if (item) item.parent_issue_url = newUrl;
  }
  moveInOrders(issue, oldUrl, newUrl, position);
}

function redrawAfterRelationChange() {
  saveIssuesCache();
  renderBoard();
  summary.textContent = summaryText();
  preloadSubIssueOrders();
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
      changeParentLocal(issue, oldUrl, parent.url, position);
      linked = true;
    } else if (position) {
      moveInOrders(issue, oldUrl, parent.url, position);
    }
    if (position) await sendRelationRequest("PATCH", `${parent.url}/sub_issues/priority`, { sub_issue_id: issue.id, ...position });
  } catch (error) {
    showNotice(`Could not move #${issue.number} under #${numberFromUrl(parent.url)}: ${apiErrorMessage(error)}`, true);
    forgetOrders(parent.url);
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
