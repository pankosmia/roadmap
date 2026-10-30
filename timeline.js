// Timeline of the issue panel: the comments and the activity of an issue, as on GitHub, below the description.
// It reads GitHub's REST timeline (comments with their rendered HTML, labels, assignees, state changes, links…),
// merges neighbouring events, folds long runs of activity (never comments) and lets a connected user comment,
// edit and delete comments, react to them and close or reopen the issue with a comment.
// Loaded before app.js; it relies on globals declared there and in markdown-editor.js (githubRequest, currentIssue…).

const TIMELINE_ORDER_KEY = "roadmap-timeline-order";
const TIMELINE_PAGE_SIZE = 100;
// The newest page is completed with older ones until this many items are shown.
const TIMELINE_MIN_ITEMS = 20;
// A run of this many activity rows in a row is folded behind one chevron row.
const TIMELINE_FOLD_MIN = 7;
// The most recent activity rows are never folded.
const TIMELINE_KEEP_RECENT = 3;
// Label and assignee events by the same person are merged when they are this close to each other.
const TIMELINE_MERGE_WINDOW = 10 * 60 * 1000;
const TIMELINE_REFRESH_DELAY = 1500;
// A comment is shown as edited when it was updated this long after its creation.
const TIMELINE_EDITED_AFTER = 5000;
// "full" gives the Markdown source (to edit a comment) next to the HTML rendered by GitHub.
const TIMELINE_ACCEPT = "application/vnd.github.full+json";

const REACTIONS = [
  { content: "+1", emoji: "👍", label: "Thumbs up", graphql: "THUMBS_UP" },
  { content: "-1", emoji: "👎", label: "Thumbs down", graphql: "THUMBS_DOWN" },
  { content: "laugh", emoji: "😄", label: "Laugh", graphql: "LAUGH" },
  { content: "hooray", emoji: "🎉", label: "Hooray", graphql: "HOORAY" },
  { content: "confused", emoji: "😕", label: "Confused", graphql: "CONFUSED" },
  { content: "heart", emoji: "❤️", label: "Heart", graphql: "HEART" },
  { content: "rocket", emoji: "🚀", label: "Rocket", graphql: "ROCKET" },
  { content: "eyes", emoji: "👀", label: "Eyes", graphql: "EYES" }
];

// Notifications that GitHub does not show in the timeline either.
const HIDDEN_EVENTS = new Set(["mentioned", "subscribed", "unsubscribed"]);
const PROJECT_EVENTS = new Set([
  "added_to_project",
  "removed_from_project",
  "moved_columns_in_project",
  "added_to_project_v2",
  "removed_from_project_v2",
  "project_v2_item_status_changed"
]);
const PROJECT_EVENT_TEXT = {
  added_to_project: "Added to a project",
  removed_from_project: "Removed from a project",
  moved_columns_in_project: "Moved in a project",
  added_to_project_v2: "Added to a project",
  removed_from_project_v2: "Removed from a project",
  project_v2_item_status_changed: "Project status changed"
};
// Never folded, so that the life of the issue stays readable.
const STATE_EVENTS = new Set(["closed", "reopened", "merged"]);
const LABEL_EVENTS = new Set(["labeled", "unlabeled"]);
const ASSIGNEE_EVENTS = new Set(["assigned", "unassigned"]);
const AUTHOR_BADGES = { OWNER: "Owner", MEMBER: "Member", COLLABORATOR: "Collaborator", CONTRIBUTOR: "Contributor" };
const REVIEW_STATES = {
  approved: { text: "approved these changes", icon: "check_circle", tone: "done" },
  changes_requested: { text: "requested changes", icon: "error", tone: "closed" },
  commented: { text: "reviewed", icon: "rate_review", tone: "muted" },
  dismissed: { text: "had a review dismissed", icon: "do_not_disturb_on", tone: "muted" }
};

// [icon, text, tone] for the events that need nothing from their payload.
const SIMPLE_EVENTS = {
  reopened: ["adjust", "reopened this", "open"],
  ready_for_review: ["rate_review", "marked this as ready for review", "open"],
  converted_to_draft: ["edit_note", "marked this as a draft", "muted"],
  head_ref_deleted: ["delete", "deleted the head branch", "muted"],
  head_ref_restored: ["restore", "restored the head branch", "muted"],
  head_ref_force_pushed: ["upload", "force-pushed the head branch", "muted"],
  base_ref_changed: ["call_split", "changed the base branch", "muted"],
  auto_merge_enabled: ["merge", "enabled auto-merge", "muted"],
  auto_merge_disabled: ["merge", "disabled auto-merge", "muted"],
  pinned: ["keep", "pinned this issue", "muted"],
  unpinned: ["keep_off", "unpinned this issue", "muted"],
  transferred: ["drive_file_move", "transferred this issue", "muted"],
  marked_as_duplicate: ["content_copy", "marked this as a duplicate", "muted"],
  unmarked_as_duplicate: ["content_copy", "unmarked this as a duplicate", "muted"],
  connected: ["link", "linked a pull request that will close this issue", "muted"],
  disconnected: ["link_off", "removed a link to a pull request", "muted"],
  unlocked: ["lock_open", "unlocked this conversation", "muted"],
  user_blocked: ["block", "blocked a user", "muted"]
};

function newTimeline(key) {
  return {
    key,
    status: "idle",
    error: "",
    pages: new Map(),
    lastPage: 1,
    lowestPage: 1,
    loadingOlder: false,
    run: 0,
    filter: "all",
    showAllActivity: false,
    expandedFolds: new Set(),
    expandedGroups: new Set(),
    editors: new Map(),
    picker: null,
    // Reactions of the connected user, by comment node id (GraphQL tells; REST only counts).
    mine: new Map(),
    busyReactions: new Set(),
    admin: false,
    posting: false,
    renderPending: false,
    refreshing: false,
    refreshTimer: 0
  };
}

let panelTimeline = newTimeline("");
let timelineUi = null;
let timelineOrder = readTimelineOrder();
let timelineConfirm = null;
const timelineRepoCache = new Map();

function readTimelineOrder() {
  try {
    return localStorage.getItem(TIMELINE_ORDER_KEY) === "newest-first" ? "newest-first" : "oldest-first";
  } catch {
    return "oldest-first";
  }
}

function saveTimelineOrder(order) {
  try {
    localStorage.setItem(TIMELINE_ORDER_KEY, order);
  } catch {
    // The order still applies until the page is reloaded.
  }
}

function safeUrl(url) {
  return /^https:\/\//.test(url || "") ? url : "#";
}

function timeHtml(isoDate) {
  if (!isoDate) return "";
  return `<time datetime="${escapeHtml(isoDate)}" title="${escapeHtml(new Date(isoDate).toLocaleString())}">${lastUpdatedText(isoDate)}</time>`;
}

function avatarHtml(user, size) {
  if (!user?.avatar_url) return "";
  return `<img class="tl-avatar" src="${escapeHtml(user.avatar_url)}" alt="" width="${size}" height="${size}" loading="lazy">`;
}

function userHtml(user, withAvatar = true) {
  if (!user) return '<span class="tl-actor">Someone</span>';
  const name = `<a class="tl-actor" href="${escapeHtml(safeUrl(user.html_url))}" target="_blank" rel="noopener">${escapeHtml(user.login)}</a>`;
  return withAvatar ? `${avatarHtml(user, 20)}${name}` : name;
}

function joinList(parts) {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function timelineLabelHtml(label) {
  const color = /^[0-9a-f]{6}$/i.test(label?.color || "") ? label.color : "";
  const style = color ? ` style="background:#${color};border-color:#${color};color:${textColorFor(color)}"` : "";
  return `<span class="label-chip"${style}>${escapeHtml(label?.name || "label")}</span>`;
}

function issueRefHtml(ref) {
  if (!ref) return "";
  const repo = ref.repository?.full_name || "";
  const url = ref.html_url || (repo ? `https://github.com/${repo}/issues/${ref.number}` : "#");
  const issue = currentIssue();
  const local = issue && repo === repoOf(issue).join("/");
  const reference = `${local ? "" : displayRepo(repo)}#${ref.number}`;
  return `<a class="tl-ref" href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noopener"><span class="tl-ref-title">${escapeHtml(ref.title || "")}</span> <span class="tl-ref-number">${escapeHtml(reference)}</span></a>`;
}

function commitHtml(sha, issue) {
  if (!sha) return "";
  const url = `https://github.com/${repoOf(issue).join("/")}/commit/${sha}`;
  return `<a class="tl-ref" href="${escapeHtml(url)}" target="_blank" rel="noopener"><code>${escapeHtml(sha.slice(0, 7))}</code></a>`;
}

function stateTone(state, pullRequest) {
  if (pullRequest?.merged_at) return "done";
  return state === "open" ? "open" : pullRequest ? "closed" : "done";
}

function describeLabels(events) {
  const added = events.filter((event) => event.event === "labeled").map((event) => timelineLabelHtml(event.label));
  const removed = events.filter((event) => event.event === "unlabeled").map((event) => timelineLabelHtml(event.label));
  const parts = [];
  if (added.length) parts.push(`added ${added.join(" ")}`);
  if (removed.length) parts.push(`removed ${removed.join(" ")}`);
  return { icon: "sell", tone: "muted", html: `${parts.join(" and ")} ${events.length > 1 ? "labels" : "label"}` };
}

function describeAssignees(events, actor) {
  const added = events.filter((event) => event.event === "assigned");
  const removed = events.filter((event) => event.event === "unassigned");
  if (events.length === 1 && added.length === 1 && added[0].assignee && added[0].assignee.login === actor?.login) {
    return { icon: "person_add", tone: "muted", html: "self-assigned this" };
  }
  const names = (list) => joinList(list.map((event) => userHtml(event.assignee, false)));
  const parts = [];
  if (added.length) parts.push(`assigned ${names(added)}`);
  if (removed.length) parts.push(`unassigned ${names(removed)}`);
  return { icon: "person_add", tone: "muted", html: parts.join(" and ") };
}

function describeClosed(event, issue) {
  const reasons = {
    completed: ["check_circle", "done", "closed this as completed"],
    not_planned: ["block", "muted", "closed this as not planned"],
    duplicate: ["block", "muted", "closed this as duplicate"]
  };
  const [icon, tone, text] = reasons[event.state_reason] || ["check_circle", "done", "closed this"];
  const commit = event.commit_id ? ` in ${commitHtml(event.commit_id, issue)}` : "";
  return { icon, tone, html: `${text}${commit}` };
}

function describeCrossReference(event) {
  const source = event.source?.issue;
  if (!source) return { icon: "link", tone: "muted", html: "mentioned this" };
  const pull = source.pull_request;
  return {
    icon: pull ? "merge_type" : "link",
    tone: pull ? stateTone(source.state, pull) : "muted",
    html: `mentioned this in ${pull ? "pull request" : "issue"} ${issueRefHtml(source)}`
  };
}

// Relationship events: the payload names the other issue under a key that depends on the event.
function describeRelation(event, text, icon) {
  const other = event.parent_issue || event.sub_issue || event.blocked_by_issue || event.blocking_issue || event.dependency;
  return { icon, tone: "muted", html: other ? `${text} ${issueRefHtml(other)}` : text };
}

function describeEvent(row, issue) {
  const event = row.events[0];
  if (row.group === "labels") return describeLabels(row.events);
  if (row.group === "assignees") return describeAssignees(row.events, row.actor);
  switch (event.event) {
    case "closed":
      return describeClosed(event, issue);
    case "merged":
      return { icon: "merge", tone: "done", html: `merged this${event.commit_id ? ` as ${commitHtml(event.commit_id, issue)}` : ""}` };
    case "renamed":
      return {
        icon: "edit",
        tone: "muted",
        html: `changed the title <s class="tl-old">${escapeHtml(event.rename?.from || "")}</s> <strong>${escapeHtml(event.rename?.to || "")}</strong>`
      };
    case "milestoned":
    case "demilestoned":
      return {
        icon: "flag",
        tone: "muted",
        html: `${event.event === "milestoned" ? "added this to" : "removed this from"} the <strong>${escapeHtml(event.milestone?.title || "")}</strong> milestone`
      };
    case "locked":
      return { icon: "lock", tone: "muted", html: `locked this conversation${event.lock_reason ? ` as ${escapeHtml(event.lock_reason)}` : ""}` };
    case "referenced":
      return { icon: "commit", tone: "muted", html: `referenced this issue in commit ${commitHtml(event.commit_id, issue)}` };
    case "cross-referenced":
      return describeCrossReference(event);
    case "parent_issue_added":
      return describeRelation(event, "added a parent issue", "arrow_upward");
    case "parent_issue_removed":
      return describeRelation(event, "removed the parent issue", "arrow_upward");
    case "sub_issue_added":
      return describeRelation(event, "added a sub-issue", "subdirectory_arrow_right");
    case "sub_issue_removed":
      return describeRelation(event, "removed a sub-issue", "subdirectory_arrow_right");
    case "blocked_by_added":
      return describeRelation(event, "marked this as blocked by", "block");
    case "blocked_by_removed":
      return describeRelation(event, "removed the block by", "block");
    case "blocking_added":
      return describeRelation(event, "marked this as blocking", "priority_high");
    case "blocking_removed":
      return describeRelation(event, "removed the blocking of", "priority_high");
    case "issue_type_added":
    case "issue_type_changed":
    case "issue_type_removed": {
      const name = event.issue_type?.name ? ` <strong>${escapeHtml(event.issue_type.name)}</strong>` : "";
      const verb = { issue_type_added: "added the", issue_type_changed: "changed the type to", issue_type_removed: "removed the" }[event.event];
      return { icon: "category", tone: "muted", html: `${verb}${name} issue type` };
    }
    case "review_requested":
    case "review_request_removed": {
      const target = event.requested_reviewer ? userHtml(event.requested_reviewer, false) : escapeHtml(event.requested_team?.name || "a reviewer");
      return { icon: "rate_review", tone: "muted", html: `${event.event === "review_requested" ? "requested a review from" : "removed the review request for"} ${target}` };
    }
    default: {
      const simple = SIMPLE_EVENTS[event.event];
      if (simple) return { icon: simple[0], tone: simple[2], html: simple[1] };
      return { icon: "history", tone: "muted", html: escapeHtml(event.event.replaceAll("_", " ")) };
    }
  }
}

function eventKey(raw) {
  return `e${raw.id ?? raw.sha ?? `${raw.event}-${raw.created_at}`}`;
}

function commentRow(raw, variant, issue) {
  const user = raw.user || raw.actor || null;
  const at = raw.created_at || raw.submitted_at;
  return {
    kind: "comment",
    variant,
    key: `${variant}${raw.id}`,
    id: raw.id,
    raw,
    user,
    at,
    isAuthor: Boolean(user && issue.user && user.login === issue.user.login)
  };
}

// One raw timeline item gives no row (hidden), one row, or one row per comment of a review thread.
function rowsOf(raw, issue) {
  const type = raw.event;
  if (HIDDEN_EVENTS.has(type)) return [];
  if (type === "commented") return [commentRow(raw, "comment", issue)];
  if (type === "reviewed") return [commentRow(raw, "review", issue)];
  if (type === "line-commented" || type === "commit-commented") {
    return (raw.comments || []).map((comment) => commentRow(comment, "thread", issue));
  }
  const group = PROJECT_EVENTS.has(type) ? "project" : LABEL_EVENTS.has(type) ? "labels" : ASSIGNEE_EVENTS.has(type) ? "assignees" : "";
  const actor = type === "committed" ? null : raw.actor || null;
  return [{ kind: "event", key: eventKey(raw), group, events: [raw], actor, at: raw.created_at || raw.committer?.date || raw.author?.date }];
}

function canMerge(previous, row) {
  if (previous.kind !== "event" || row.kind !== "event" || !row.group || previous.group !== row.group) return false;
  if (row.group === "project") return true;
  if ((previous.actor?.login || "") !== (row.actor?.login || "")) return false;
  return Date.parse(row.at) - Date.parse(previous.events[previous.events.length - 1].created_at) <= TIMELINE_MERGE_WINDOW;
}

function buildRows(items, issue) {
  const rows = [];
  const seen = new Set();
  for (const raw of items) {
    for (const row of rowsOf(raw, issue)) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      const previous = rows[rows.length - 1];
      if (previous && canMerge(previous, row)) previous.events.push(...row.events);
      else rows.push(row);
    }
  }
  return rows;
}

// Runs of TIMELINE_FOLD_MIN or more activity rows become one fold row. Comments, state changes and the most
// recent activity are kept out of the runs, so they are always visible.
function foldRows(rows) {
  const kept = new Set();
  let recent = 0;
  for (let index = rows.length - 1; index >= 0 && recent < TIMELINE_KEEP_RECENT; index -= 1) {
    if (rows[index].kind !== "event") continue;
    kept.add(rows[index]);
    recent += 1;
  }
  const result = [];
  let run = [];
  const flush = () => {
    if (run.length >= TIMELINE_FOLD_MIN) result.push({ kind: "fold", key: `f${run[0].key}`, rows: run });
    else result.push(...run);
    run = [];
  };
  for (const row of rows) {
    const foldable = row.kind === "event" && !kept.has(row) && !STATE_EVENTS.has(row.events[0].event);
    if (foldable) {
      run.push(row);
    } else {
      flush();
      result.push(row);
    }
  }
  flush();
  return result;
}

function timelineItems(timeline) {
  const items = [];
  for (let page = timeline.lowestPage; page <= timeline.lastPage; page += 1) items.push(...(timeline.pages.get(page) || []));
  return items;
}

function allTimelineComments(timeline) {
  return timelineItems(timeline).filter((raw) => raw.event === "commented");
}

function findComment(timeline, id) {
  return allTimelineComments(timeline).find((raw) => raw.id === id) || null;
}

function replaceComment(timeline, updated) {
  for (const items of timeline.pages.values()) {
    const index = items.findIndex((raw) => raw.event === "commented" && raw.id === updated.id);
    if (index !== -1) items[index] = { ...items[index], ...updated, event: "commented" };
  }
}

function removeComment(timeline, id) {
  for (const [page, items] of timeline.pages) {
    timeline.pages.set(page, items.filter((raw) => !(raw.event === "commented" && raw.id === id)));
  }
}

/* ---------- Rendering ---------- */

function reactionsHtml(row, timeline) {
  const reactions = row.raw.reactions || {};
  const mine = timeline.mine.get(row.raw.node_id) || new Set();
  const disabled = accessToken ? "" : "disabled";
  const pills = REACTIONS.filter((reaction) => reactions[reaction.content] > 0)
    .map((reaction) => `
      <button type="button" class="tl-reaction${mine.has(reaction.content) ? " is-mine" : ""}" data-action="react" data-comment="${row.id}" data-content="${reaction.content}"
        data-focus-key="react:${row.id}:${reaction.content}" aria-pressed="${mine.has(reaction.content)}" title="${reaction.label}" ${disabled}>
        <span aria-hidden="true">${reaction.emoji}</span><span>${reactions[reaction.content]}</span>
      </button>`)
    .join("");
  const open = timeline.picker === row.id;
  const add = accessToken
    ? `<button type="button" class="tl-reaction tl-reaction-add" data-action="picker" data-comment="${row.id}" data-focus-key="picker:${row.id}" aria-label="Add reaction" aria-expanded="${open}"><md-icon>add_reaction</md-icon></button>`
    : "";
  const picker = open
    ? `<div class="tl-picker" role="group" aria-label="Pick a reaction">${REACTIONS.map((reaction) => `
        <button type="button" class="tl-reaction" data-action="react" data-comment="${row.id}" data-content="${reaction.content}" data-focus-key="react:${row.id}:${reaction.content}" title="${reaction.label}" aria-label="${reaction.label}">${reaction.emoji}</button>`).join("")}</div>`
    : "";
  return pills || add ? `<div class="tl-reactions">${pills}${add}</div>${picker}` : "";
}

function commentActionsHtml(row, timeline) {
  const mine = accessToken && row.user && row.user.login === currentLogin;
  const button = (action, icon, label) =>
    `<md-icon-button class="tl-action" data-action="${action}" data-comment="${row.id}" data-focus-key="${action}:${row.id}" aria-label="${label}" title="${label}"><md-icon>${icon}</md-icon></md-icon-button>`;
  const actions = [];
  if (accessToken) actions.push(button("quote-reply", "format_quote", "Quote reply"));
  actions.push(button("copy", "link", "Copy link"));
  if (mine) actions.push(button("edit", "edit", "Edit comment"));
  if (mine || timeline.admin) actions.push(button("delete", "delete", "Delete comment"));
  return `<div class="tl-actions">${actions.join("")}</div>`;
}

function commentHtml(row, timeline) {
  const { raw, user } = row;
  const isIssueComment = row.variant === "comment";
  const badge = row.isAuthor ? "Author" : AUTHOR_BADGES[raw.author_association] || "";
  let verb = "commented";
  let extra = "";
  let tone = "";
  if (row.variant === "review") {
    const state = REVIEW_STATES[String(raw.state || "").toLowerCase()] || REVIEW_STATES.commented;
    verb = state.text;
    tone = ` tl-tone-${state.tone}`;
  } else if (row.variant === "thread") {
    verb = "commented on";
    extra = ` <code>${escapeHtml(raw.path || "a file")}</code>`;
  }
  const edited = isIssueComment && Date.parse(raw.updated_at) - Date.parse(raw.created_at) > TIMELINE_EDITED_AFTER;
  const editing = isIssueComment && timeline.editors.has(row.id);
  let body = "";
  if (editing) body = `<div class="tl-edit-slot" data-edit-slot="${row.id}"></div>`;
  else if (raw.body_html) body = `<div class="tl-comment-body markdown-body">${raw.body_html}</div>`;
  else if (row.variant !== "review") body = '<p class="tl-empty">No description provided.</p>';
  if (raw.minimized && !editing) body = `<details class="tl-minimized"><summary>Hidden comment</summary>${body}</details>`;
  return `
    <li class="tl-item tl-comment${tone}" data-key="${escapeHtml(row.key)}">
      ${avatarHtml(user, 32) || '<span class="tl-avatar tl-avatar-empty"></span>'}
      <div class="tl-card">
        <header class="tl-card-header">
          <span class="tl-card-title">${userHtml(user, false)} ${verb}${extra} ${timeHtml(row.at)}${edited ? ' <span class="tl-edited" title="Edited">· edited</span>' : ""}</span>
          ${badge ? `<span class="tl-badge-text">${badge}</span>` : ""}
          ${isIssueComment && !editing ? commentActionsHtml(row, timeline) : ""}
        </header>
        ${body}
        ${isIssueComment && !editing ? reactionsHtml(row, timeline) : ""}
      </div>
    </li>`;
}

function eventHtml(row, issue) {
  const { icon, tone, html } = describeEvent(row, issue);
  const actor = row.events[0].event === "committed"
    ? `<span class="tl-actor">${escapeHtml(row.events[0].author?.name || "Someone")}</span>`
    : userHtml(row.actor);
  let text = `${actor} ${html}`;
  if (row.events[0].event === "committed") {
    const commit = row.events[0];
    text = `${actor} committed <a class="tl-ref" href="${escapeHtml(safeUrl(commit.html_url))}" target="_blank" rel="noopener"><span class="tl-ref-title">${escapeHtml(String(commit.message || "").split("\n")[0])}</span> <code>${escapeHtml(String(commit.sha || "").slice(0, 7))}</code></a>`;
  }
  return `
    <li class="tl-item tl-event" data-key="${escapeHtml(row.key)}">
      <span class="tl-badge tl-tone-${tone}"><md-icon>${row.events[0].event === "committed" ? "commit" : icon}</md-icon></span>
      <div class="tl-event-body"><span class="tl-event-text">${text}</span> ${timeHtml(row.at)}</div>
    </li>`;
}

function projectHtml(row, timeline) {
  const open = timeline.expandedGroups.has(row.key);
  const details = open
    ? `<ul class="tl-details">${row.events.map((event) => `
        <li>${escapeHtml(PROJECT_EVENT_TEXT[event.event] || event.event.replaceAll("_", " "))} · ${userHtml(event.actor, false)} · ${timeHtml(event.created_at)}</li>`).join("")}</ul>`
    : "";
  const count = row.events.length;
  return `
    <li class="tl-item tl-event tl-project" data-key="${escapeHtml(row.key)}">
      <span class="tl-badge tl-tone-muted"><md-icon>view_kanban</md-icon></span>
      <div class="tl-event-body">
        <button type="button" class="tl-toggle tl-toggle-inline" data-action="group" data-key="${escapeHtml(row.key)}" data-focus-key="group:${escapeHtml(row.key)}" aria-expanded="${open}">
          <span>Dashboard workflow actions were performed</span>
          <span class="tl-count">${count} ${count === 1 ? "change" : "changes"}</span>
          <md-icon class="tl-chevron">expand_more</md-icon>
        </button>
        ${details}
      </div>
    </li>`;
}

function foldHtml(row, timeline, issue) {
  const open = timeline.expandedFolds.has(row.key);
  const count = row.rows.length;
  const inner = open ? `<ol class="tl-fold-items">${orderRows(row.rows).map((item) => rowHtml(item, timeline, issue)).join("")}</ol>` : "";
  return `
    <li class="tl-item tl-fold" data-key="${escapeHtml(row.key)}">
      <button type="button" class="tl-toggle" data-action="fold" data-key="${escapeHtml(row.key)}" data-focus-key="fold:${escapeHtml(row.key)}" aria-expanded="${open}">
        <md-icon>${open ? "unfold_less" : "unfold_more"}</md-icon>
        <span>${open ? `Hide ${count} activity items` : `${count} activity items hidden`}</span>
        <md-icon class="tl-chevron">expand_more</md-icon>
      </button>
      ${inner}
    </li>`;
}

function rowHtml(row, timeline, issue) {
  if (row.kind === "comment") return commentHtml(row, timeline);
  if (row.kind === "fold") return foldHtml(row, timeline, issue);
  if (row.group === "project") return projectHtml(row, timeline);
  return eventHtml(row, issue);
}

function orderRows(rows) {
  return timelineOrder === "newest-first" ? [...rows].reverse() : rows;
}

function openedHtml(issue) {
  return `
    <li class="tl-item tl-event tl-opened" data-key="opened">
      <span class="tl-badge tl-tone-open"><md-icon>adjust</md-icon></span>
      <div class="tl-event-body"><span class="tl-event-text">${userHtml(issue.user)} opened this issue</span> ${timeHtml(issue.created_at)}</div>
    </li>`;
}

function olderHtml(timeline) {
  const count = (timeline.lowestPage - 1) * TIMELINE_PAGE_SIZE;
  return `
    <li class="tl-item tl-older" data-key="older">
      <button type="button" class="tl-toggle" data-action="older" data-focus-key="older" ${timeline.loadingOlder ? "disabled" : ""}>
        <md-icon>history</md-icon><span>${timeline.loadingOlder ? "Loading…" : `Load older items (${count} earlier)`}</span>
      </button>
    </li>`;
}

function statusHtml(timeline) {
  if (timeline.status === "loading") {
    return '<li class="tl-item tl-status"><md-circular-progress indeterminate aria-label="Loading the timeline"></md-circular-progress><span>Loading the timeline…</span></li>';
  }
  if (timeline.status === "error") {
    return `<li class="tl-item tl-status tl-status-error" role="alert"><md-icon>error</md-icon><span>Could not load the timeline: ${escapeHtml(timeline.error)}</span><md-text-button data-action="retry" data-focus-key="retry">Retry</md-text-button></li>`;
  }
  return "";
}

function isTypingInTimeline() {
  const active = document.activeElement;
  return Boolean(timelineUi && active && timelineUi.list.contains(active) && active.matches("textarea, input"));
}

function scrollParentOf(element) {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return document.scrollingElement;
}

function renderTimeline() {
  if (!timelineUi || panelIssueId === null) return;
  const issue = currentIssue();
  const timeline = panelTimeline;
  if (!issue || issue.draft) return;
  if (isTypingInTimeline()) {
    timeline.renderPending = true;
    return;
  }
  timeline.renderPending = false;
  const { list } = timelineUi;
  const focusKey = document.activeElement?.closest?.("[data-focus-key]")?.dataset.focusKey;

  let rows = buildRows(timelineItems(timeline), issue);
  if (timeline.filter === "comments") rows = rows.filter((row) => row.kind === "comment");
  else if (timeline.filter === "activity") rows = rows.filter((row) => row.kind === "event");
  else if (!timeline.showAllActivity) rows = foldRows(rows);

  const older = timeline.lowestPage > 1 ? olderHtml(timeline) : "";
  const body = orderRows(rows).map((row) => rowHtml(row, timeline, issue)).join("");
  const status = statusHtml(timeline);
  const parts = timelineOrder === "newest-first" ? [status, body, older, openedHtml(issue)] : [openedHtml(issue), older, status, body];
  list.innerHTML = parts.join("");

  for (const [id, entry] of timeline.editors) list.querySelector(`[data-edit-slot="${id}"]`)?.append(entry.element);
  list.querySelectorAll(".tl-comment-body a[href]").forEach((link) => {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  });
  if (focusKey) list.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  renderTimelineChrome();
}

function renderTimelineChrome() {
  if (!timelineUi) return;
  const { section, filters, expand, order, composer, readonly, send, close, error } = timelineUi;
  const issue = currentIssue();
  const timeline = panelTimeline;
  section.hidden = !issue || Boolean(issue.draft);
  if (section.hidden) return;
  for (const chip of filters) chip.setAttribute("aria-pressed", String(chip.dataset.filter === timeline.filter));
  expand.hidden = timeline.filter !== "all";
  expand.setAttribute("aria-pressed", String(timeline.showAllActivity));
  expand.textContent = timeline.showAllActivity ? "Fold activity" : "Show all activity";
  const newestFirst = timelineOrder === "newest-first";
  order.querySelector("md-icon").textContent = newestFirst ? "arrow_upward" : "arrow_downward";
  const orderLabel = newestFirst ? "Newest first. Show oldest first" : "Oldest first. Show newest first";
  order.setAttribute("aria-label", orderLabel);
  order.title = orderLabel;

  const slot = newestFirst ? timelineUi.topSlot : timelineUi.bottomSlot;
  if (composer.parentElement !== slot) slot.append(composer);
  composer.hidden = !accessToken;
  readonly.hidden = Boolean(accessToken);
  if (readonly.parentElement !== slot) slot.append(readonly);
  if (!accessToken) return;
  const text = timelineUi.editor.value.trim();
  const closed = isClosed(issue);
  const busy = timeline.posting || stateChangeBusy;
  send.disabled = busy || !text;
  close.disabled = busy;
  close.querySelector(".tl-close-label").textContent = closed ? (text ? "Reopen with comment" : "Reopen issue") : text ? "Close with comment" : "Close issue";
  timelineUi.avatar.src = currentLogin ? `https://github.com/${encodeURIComponent(currentLogin)}.png?size=64` : "";
  timelineUi.avatar.hidden = !currentLogin;
  error.hidden = !error.textContent;
}

/* ---------- Loading ---------- */

function lastPageOf(response) {
  const match = /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(response.headers.get("link") || "");
  return match ? Number(match[1]) : 0;
}

function fetchTimelinePage(issue, page) {
  return githubRequestWithResponse(
    `${issueEndpoint(issue)}/timeline?per_page=${TIMELINE_PAGE_SIZE}&page=${page}`,
    { headers: { Accept: TIMELINE_ACCEPT }, cache: "no-cache" },
    accessToken
  );
}

async function ensureTimelinePage(issue, timeline, page) {
  if (timeline.pages.has(page)) return;
  const { data } = await fetchTimelinePage(issue, page);
  if (panelTimeline === timeline) timeline.pages.set(page, data);
}

// The newest page is shown first. Page 1 gives the page count through the Link header and is kept for later.
async function loadTimeline(issue, timeline) {
  try {
    const first = await fetchTimelinePage(issue, 1);
    if (panelTimeline !== timeline) return;
    timeline.pages.set(1, first.data);
    timeline.lastPage = Math.max(1, lastPageOf(first.response));
    timeline.lowestPage = timeline.lastPage;
    await ensureTimelinePage(issue, timeline, timeline.lastPage);
    while (panelTimeline === timeline && timeline.lowestPage > 1 && timelineItems(timeline).length < TIMELINE_MIN_ITEMS) {
      timeline.lowestPage -= 1;
      await ensureTimelinePage(issue, timeline, timeline.lowestPage);
    }
    if (panelTimeline !== timeline) return;
    timeline.status = "ready";
  } catch (error) {
    if (panelTimeline !== timeline) return;
    timeline.status = "error";
    timeline.error = apiErrorMessage(error);
  }
  renderTimeline();
  loadViewerReactions(timeline);
}

async function loadOlderTimeline() {
  const issue = currentIssue();
  const timeline = panelTimeline;
  if (!issue || timeline.loadingOlder || timeline.lowestPage <= 1) return;
  timeline.loadingOlder = true;
  renderTimeline();
  const anchor = timelineUi.list.querySelector('[data-key="older"]');
  const before = anchor ? anchor.getBoundingClientRect().top : 0;
  try {
    await ensureTimelinePage(issue, timeline, timeline.lowestPage - 1);
    if (panelTimeline !== timeline) return;
    timeline.lowestPage -= 1;
  } catch (error) {
    if (panelTimeline === timeline) showNotice(`Could not load older items: ${apiErrorMessage(error)}`, true);
  } finally {
    if (panelTimeline === timeline) {
      timeline.loadingOlder = false;
      renderTimeline();
      // Older items are inserted above the button: keep what the user was reading where it was.
      const after = timelineUi.list.querySelector('[data-key="older"]') || timelineUi.list.querySelector('[data-key="opened"]');
      if (anchor && after && timelineOrder === "oldest-first") scrollParentOf(timelineUi.list).scrollTop += after.getBoundingClientRect().top - before;
      loadViewerReactions(timeline);
    }
  }
}

// Fetches the pages that are shown again (a conditional request, so an unchanged page costs no rate limit).
async function refreshTimeline() {
  const issue = currentIssue();
  const timeline = panelTimeline;
  if (!issue || issue.draft || timeline.status !== "ready" || timeline.refreshing) return;
  timeline.refreshing = true;
  try {
    let page = timeline.lowestPage;
    let head = await fetchTimelinePage(issue, page);
    while (head.data.length === 0 && page > 1) {
      page -= 1;
      head = await fetchTimelinePage(issue, page);
    }
    const last = Math.max(page, lastPageOf(head.response));
    const pages = new Map([[page, head.data]]);
    const rest = [];
    for (let next = page + 1; next <= last; next += 1) rest.push(fetchTimelinePage(issue, next).then(({ data }) => pages.set(next, data)));
    await Promise.all(rest);
    if (panelTimeline !== timeline) return;
    timeline.pages = pages;
    timeline.lowestPage = page;
    timeline.lastPage = last;
    renderTimeline();
    loadViewerReactions(timeline);
  } catch {
    // The next live update or action tries again; what is shown stays valid.
  } finally {
    timeline.refreshing = false;
  }
}

function refreshTimelineSoon() {
  const timeline = panelTimeline;
  if (!timelineUi || panelIssueId === null) return;
  clearTimeout(timeline.refreshTimer);
  timeline.refreshTimer = setTimeout(refreshTimeline, TIMELINE_REFRESH_DELAY);
}

async function loadViewerReactions(timeline) {
  if (!accessToken) return;
  const ids = [...new Set(allTimelineComments(timeline)
    .filter((raw) => raw.reactions?.total_count > 0 && raw.node_id && !timeline.mine.has(raw.node_id))
    .map((raw) => raw.node_id))];
  const groupToRest = new Map(REACTIONS.map((reaction) => [reaction.graphql, reaction.content]));
  try {
    for (let start = 0; start < ids.length; start += 100) {
      const result = await githubRequest(
        `${API_ROOT}/graphql`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: "query($ids: [ID!]!) { nodes(ids: $ids) { ... on IssueComment { id reactionGroups { content viewerHasReacted } } } }",
            variables: { ids: ids.slice(start, start + 100) }
          })
        },
        accessToken
      );
      if (panelTimeline !== timeline) return;
      for (const node of result.data?.nodes || []) {
        if (!node?.id) continue;
        timeline.mine.set(node.id, new Set(node.reactionGroups.filter((group) => group.viewerHasReacted).map((group) => groupToRest.get(group.content))));
      }
    }
    renderTimeline();
  } catch {
    // Without it the reactions are shown as not yet chosen; choosing one still toggles correctly.
  }
}

function loadAdminFlag(issue, timeline) {
  if (!accessToken) return;
  const repo = repoOf(issue).join("/");
  cachedRequest(timelineRepoCache, `${accessToken.slice(-6)}|${repo}`, () =>
    githubRequest(`${API_ROOT}/repos/${repo.split("/").map(encodeURIComponent).join("/")}`, {}, accessToken)
  )
    .then((repository) => {
      if (panelTimeline !== timeline) return;
      timeline.admin = Boolean(repository.permissions?.admin);
      renderTimeline();
    })
    .catch(() => {});
}

// Called by the panel on every refresh; it loads the timeline once per issue (and per sign-in state).
function ensureTimeline(issue) {
  if (!timelineUi) return;
  if (issue.draft) {
    renderTimelineChrome();
    return;
  }
  const key = `${issue.id}|${Boolean(accessToken)}`;
  if (panelTimeline.key !== key) {
    clearTimeout(panelTimeline.refreshTimer);
    panelTimeline = newTimeline(key);
    panelTimeline.status = "loading";
    renderTimeline();
    loadTimeline(issue, panelTimeline);
    loadAdminFlag(issue, panelTimeline);
    return;
  }
  renderTimelineChrome();
}

// A new panel starts from a clean timeline, composer and filter.
function resetTimeline() {
  if (!timelineUi) return;
  clearTimeout(panelTimeline.refreshTimer);
  panelTimeline = newTimeline("");
  timelineOrder = readTimelineOrder();
  timelineUi.editor.value = "";
  timelineUi.editor.showWrite();
  timelineUi.error.textContent = "";
  timelineUi.list.replaceChildren();
}

function timelineHasUnsavedChanges() {
  if (!timelineUi) return false;
  if (timelineUi.editor.value.trim()) return true;
  for (const entry of panelTimeline.editors.values()) if (entry.editor.value !== entry.original) return true;
  return false;
}

/* ---------- Actions ---------- */

function confirmTimelineAction({ headline, message, confirmText }) {
  if (!timelineConfirm) {
    timelineConfirm = document.createElement("md-dialog");
    timelineConfirm.innerHTML = `
      <div slot="headline"></div>
      <form id="timeline-confirm-form" slot="content" method="dialog"></form>
      <div slot="actions">
        <md-text-button form="timeline-confirm-form" value="cancel" autofocus>Cancel</md-text-button>
        <md-filled-button form="timeline-confirm-form" value="confirm"></md-filled-button>
      </div>
    `;
    document.body.append(timelineConfirm);
  }
  timelineConfirm.querySelector('[slot="headline"]').textContent = headline;
  timelineConfirm.querySelector("form").textContent = message;
  timelineConfirm.querySelector("md-filled-button").textContent = confirmText;
  timelineConfirm.returnValue = "";
  return new Promise((resolve) => {
    timelineConfirm.addEventListener("closed", () => resolve(timelineConfirm.returnValue === "confirm"), { once: true });
    timelineConfirm.show();
  });
}

function commentEndpoint(issue, id) {
  const [owner, repository] = repoOf(issue);
  return `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/comments/${id}`;
}

function showComposerError(message) {
  timelineUi.error.textContent = message;
  timelineUi.error.hidden = !message;
}

// With "close" or "reopen", the comment (if any) is posted first, then the state changes, as on GitHub.
async function submitComment(stateAction = null) {
  const issue = currentIssue();
  const timeline = panelTimeline;
  const text = timelineUi.editor.value.trim();
  if (!issue || issue.draft || timeline.posting || (!text && !stateAction)) return;
  if (!accessToken) {
    openAuthDialog();
    return;
  }
  timeline.posting = true;
  showComposerError("");
  renderTimelineChrome();
  try {
    if (text) {
      const comment = await githubRequest(
        `${issueEndpoint(issue)}/comments`,
        { method: "POST", headers: { "Content-Type": "application/json", Accept: TIMELINE_ACCEPT }, body: JSON.stringify({ body: text }) },
        accessToken
      );
      if (panelTimeline === timeline) {
        timeline.pages.get(timeline.lastPage)?.push({ ...comment, event: "commented", actor: comment.user });
        timelineUi.editor.value = "";
        timelineUi.editor.showWrite();
      }
    }
  } catch (error) {
    if (panelTimeline === timeline) showComposerError(`Could not post the comment: ${apiErrorMessage(error)}`);
    timeline.posting = false;
    renderTimelineChrome();
    return;
  }
  timeline.posting = false;
  renderTimeline();
  if (stateAction === "close") await closeIssue(issue, "completed");
  else if (stateAction === "reopen") await requestReopen(issue);
  refreshTimelineSoon();
}

function startEdit(timeline, id) {
  const comment = findComment(timeline, id);
  if (!comment || timeline.editors.has(id)) return;
  const element = document.createElement("div");
  element.className = "tl-edit";
  const editor = createMarkdownEditor({
    renderPreview: renderMarkdownPreview,
    onSubmit: () => saveEdit(timeline, id),
    label: "Edit comment",
    placeholder: "Leave a comment"
  });
  element.append(editor.element);
  element.insertAdjacentHTML("beforeend", `
    <p class="tl-edit-error auth-error" role="alert" hidden></p>
    <div class="tl-edit-actions">
      <md-text-button class="tl-edit-cancel" type="button">Cancel</md-text-button>
      <md-filled-button class="tl-edit-save" type="button">Update comment</md-filled-button>
    </div>`);
  editor.value = comment.body || "";
  const entry = { editor, element, original: comment.body || "", saving: false };
  element.querySelector(".tl-edit-cancel").addEventListener("click", () => cancelEdit(timeline, id));
  element.querySelector(".tl-edit-save").addEventListener("click", () => saveEdit(timeline, id));
  timeline.editors.set(id, entry);
  renderTimeline();
  editor.focus();
}

async function cancelEdit(timeline, id) {
  const entry = timeline.editors.get(id);
  if (!entry || entry.saving) return;
  if (entry.editor.value !== entry.original) {
    const discard = await confirmTimelineAction({ headline: "Discard changes?", message: "Your unsaved changes to this comment will be lost.", confirmText: "Discard" });
    if (!discard) return;
  }
  timeline.editors.delete(id);
  renderTimeline();
}

async function saveEdit(timeline, id) {
  const issue = currentIssue();
  const entry = timeline.editors.get(id);
  if (!issue || !entry || entry.saving) return;
  const errorLine = entry.element.querySelector(".tl-edit-error");
  const save = entry.element.querySelector(".tl-edit-save");
  const body = entry.editor.value;
  errorLine.hidden = true;
  if (!body.trim()) {
    errorLine.textContent = "The comment cannot be empty.";
    errorLine.hidden = false;
    return;
  }
  entry.saving = true;
  save.disabled = true;
  try {
    const updated = await githubRequest(
      commentEndpoint(issue, id),
      { method: "PATCH", headers: { "Content-Type": "application/json", Accept: TIMELINE_ACCEPT }, body: JSON.stringify({ body }) },
      accessToken
    );
    if (panelTimeline !== timeline) return;
    replaceComment(timeline, updated);
    timeline.editors.delete(id);
    renderTimeline();
  } catch (error) {
    errorLine.textContent = `Could not update the comment: ${apiErrorMessage(error)}`;
    errorLine.hidden = false;
    entry.saving = false;
    save.disabled = false;
  }
}

async function deleteComment(timeline, id) {
  const issue = currentIssue();
  if (!issue) return;
  const confirmed = await confirmTimelineAction({ headline: "Delete comment?", message: "This comment will be deleted for everyone. This cannot be undone.", confirmText: "Delete" });
  if (!confirmed || panelTimeline !== timeline) return;
  try {
    await githubRequest(commentEndpoint(issue, id), { method: "DELETE" }, accessToken);
    if (panelTimeline !== timeline) return;
    timeline.editors.delete(id);
    removeComment(timeline, id);
    renderTimeline();
    refreshTimelineSoon();
  } catch (error) {
    showNotice(`Could not delete the comment: ${apiErrorMessage(error)}`, true);
  }
}

function quoteComment(timeline, id) {
  const comment = findComment(timeline, id);
  if (!comment || !timelineUi) return;
  const quote = String(comment.body || "").trim().split("\n").map((line) => `> ${line}`).join("\n");
  const current = timelineUi.editor.value;
  timelineUi.editor.value = `${current}${current && !current.endsWith("\n\n") ? (current.endsWith("\n") ? "\n" : "\n\n") : ""}@${comment.user?.login || "someone"} wrote:\n\n${quote}\n\n`;
  timelineUi.composer.scrollIntoView({ block: "nearest" });
  timelineUi.editor.focus();
}

async function copyCommentLink(timeline, id) {
  const comment = findComment(timeline, id);
  if (!comment) return;
  try {
    await navigator.clipboard.writeText(comment.html_url);
    showNotice("Comment link copied.");
  } catch {
    showNotice("Could not copy the link. Your browser blocked access to the clipboard.", true);
  }
}

// POST answers 201 for a new reaction and 200 with the existing one when the user already reacted: that one is removed.
async function toggleReaction(timeline, id, content) {
  const issue = currentIssue();
  const comment = findComment(timeline, id);
  const busyKey = `${id}:${content}`;
  if (!issue || !comment || !accessToken || timeline.busyReactions.has(busyKey)) return;
  timeline.busyReactions.add(busyKey);
  timeline.picker = null;
  try {
    const url = `${commentEndpoint(issue, id)}/reactions`;
    const { data, response } = await githubRequestWithResponse(
      url,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) },
      accessToken
    );
    let delta = 1;
    if (response.status === 200) {
      await githubRequest(`${url}/${data.id}`, { method: "DELETE" }, accessToken);
      delta = -1;
    }
    if (panelTimeline !== timeline) return;
    const mine = new Set(timeline.mine.get(comment.node_id) || []);
    if (delta > 0) mine.add(content);
    else mine.delete(content);
    timeline.mine.set(comment.node_id, mine);
    const reactions = { ...comment.reactions };
    reactions[content] = Math.max(0, (reactions[content] || 0) + delta);
    reactions.total_count = Math.max(0, (reactions.total_count || 0) + delta);
    replaceComment(timeline, { id, reactions });
  } catch (error) {
    showNotice(`Could not change the reaction: ${apiErrorMessage(error)}`, true);
  } finally {
    timeline.busyReactions.delete(busyKey);
    if (panelTimeline === timeline) renderTimeline();
  }
}

function onTimelineClick(event) {
  const target = event.target.closest("[data-action]");
  // The Markdown toolbars inside the editors use data-action too.
  if (!target || target.closest(".md-editor") || !timelineUi.section.contains(target)) return;
  const timeline = panelTimeline;
  const id = Number(target.dataset.comment);
  switch (target.dataset.action) {
    case "fold":
      toggleSetValue(timeline.expandedFolds, target.dataset.key);
      renderTimeline();
      break;
    case "group":
      toggleSetValue(timeline.expandedGroups, target.dataset.key);
      renderTimeline();
      break;
    case "older":
      loadOlderTimeline();
      break;
    case "retry": {
      const issue = currentIssue();
      if (!issue) break;
      timeline.status = "loading";
      renderTimeline();
      loadTimeline(issue, timeline);
      break;
    }
    case "picker":
      timeline.picker = timeline.picker === id ? null : id;
      renderTimeline();
      break;
    case "react":
      toggleReaction(timeline, id, target.dataset.content);
      break;
    case "quote-reply":
      quoteComment(timeline, id);
      break;
    case "copy":
      copyCommentLink(timeline, id);
      break;
    case "edit":
      startEdit(timeline, id);
      break;
    case "delete":
      deleteComment(timeline, id);
      break;
    default:
  }
}

function toggleSetValue(set, value) {
  if (!set.delete(value)) set.add(value);
}

/* ---------- Setup ---------- */

function createTimeline(container) {
  const section = document.createElement("section");
  section.className = "timeline";
  section.setAttribute("aria-labelledby", "timeline-heading");
  section.hidden = true;
  section.innerHTML = `
    <div class="timeline-bar">
      <h2 class="timeline-heading" id="timeline-heading">Timeline</h2>
      <div class="connected-group timeline-filters" role="group" aria-label="Show">
        <button type="button" class="connected-button" data-filter="all" aria-pressed="true"><md-ripple></md-ripple><md-focus-ring></md-focus-ring><span>All</span></button>
        <button type="button" class="connected-button" data-filter="comments" aria-pressed="false"><md-ripple></md-ripple><md-focus-ring></md-focus-ring><span>Comments</span></button>
        <button type="button" class="connected-button" data-filter="activity" aria-pressed="false"><md-ripple></md-ripple><md-focus-ring></md-focus-ring><span>Activity</span></button>
      </div>
      <button type="button" class="timeline-chip timeline-expand" aria-pressed="false">Show all activity</button>
      <md-icon-button class="timeline-order" type="button"><md-icon>arrow_downward</md-icon></md-icon-button>
    </div>
    <div class="timeline-slot" data-slot="top"></div>
    <ol class="timeline-list" aria-label="Timeline of this issue"></ol>
    <div class="timeline-slot" data-slot="bottom"></div>
  `;
  const composer = document.createElement("div");
  composer.className = "timeline-composer";
  composer.innerHTML = `
    <img class="tl-avatar timeline-composer-avatar" alt="" width="32" height="32" hidden>
    <div class="timeline-composer-main">
      <p class="timeline-composer-error auth-error" role="alert" hidden></p>
      <div class="timeline-composer-actions">
        <md-outlined-button class="tl-close" type="button"><md-icon slot="icon">check_circle</md-icon><span class="tl-close-label">Close issue</span></md-outlined-button>
        <md-filled-button class="tl-send" type="button" disabled>Comment</md-filled-button>
      </div>
    </div>
  `;
  const readonly = document.createElement("p");
  readonly.className = "timeline-readonly";
  readonly.innerHTML = '<md-icon>lock</md-icon><span>Connect GitHub to comment.</span><md-text-button type="button">Connect</md-text-button>';
  readonly.querySelector("md-text-button").addEventListener("click", openAuthDialog);

  const editor = createMarkdownEditor({
    renderPreview: renderMarkdownPreview,
    onSubmit: () => submitComment(),
    onInput: () => renderTimelineChrome(),
    label: "Comment",
    placeholder: "Leave a comment"
  });
  const main = composer.querySelector(".timeline-composer-main");
  main.prepend(editor.element);
  container.append(section);

  timelineUi = {
    section,
    list: section.querySelector(".timeline-list"),
    topSlot: section.querySelector('[data-slot="top"]'),
    bottomSlot: section.querySelector('[data-slot="bottom"]'),
    filters: [...section.querySelectorAll("[data-filter]")],
    expand: section.querySelector(".timeline-expand"),
    order: section.querySelector(".timeline-order"),
    composer,
    readonly,
    editor,
    avatar: composer.querySelector(".timeline-composer-avatar"),
    send: composer.querySelector(".tl-send"),
    close: composer.querySelector(".tl-close"),
    error: composer.querySelector(".timeline-composer-error")
  };

  for (const chip of timelineUi.filters) {
    chip.addEventListener("click", () => {
      panelTimeline.filter = chip.dataset.filter;
      renderTimeline();
    });
  }
  timelineUi.expand.addEventListener("click", () => {
    panelTimeline.showAllActivity = !panelTimeline.showAllActivity;
    renderTimeline();
  });
  timelineUi.order.addEventListener("click", () => {
    timelineOrder = timelineOrder === "newest-first" ? "oldest-first" : "newest-first";
    saveTimelineOrder(timelineOrder);
    renderTimeline();
  });
  timelineUi.send.addEventListener("click", () => submitComment());
  timelineUi.close.addEventListener("click", () => {
    const issue = currentIssue();
    if (issue) submitComment(isClosed(issue) ? "reopen" : "close");
  });
  section.addEventListener("click", onTimelineClick);
  // A refresh that arrived while a comment was being typed is applied once the field is left.
  timelineUi.list.addEventListener("focusout", () => {
    setTimeout(() => {
      if (panelTimeline.renderPending && !isTypingInTimeline()) renderTimeline();
    }, 0);
  });
  // The order is shared by all pages of the dashboard.
  window.addEventListener("storage", (event) => {
    if (event.key !== TIMELINE_ORDER_KEY) return;
    timelineOrder = readTimelineOrder();
    renderTimeline();
  });
}
