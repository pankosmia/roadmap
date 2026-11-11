// Description card of the side panel: the opening message of an existing issue is shown as on GitHub (author, date,
// "edited", rendered Markdown with clickable task-list checkboxes, reactions, copyable link) and only becomes editable
// on demand. It can be collapsed, and a long description scrolls inside the card until it is expanded to its full height.
// Loaded before app.js; it relies on globals declared there and in timeline.js (githubRequest, currentIssue, TIMELINE_ACCEPT…).

const EDITED_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { lastEditedAt editor { login } reactionGroups { content viewerHasReacted } }
  }
}`;
// A task list item: optional quote marks, a list marker, then "[ ]" or "[x]". `[` follows the captured prefix.
const TASK_MARKER = /^([ \t>]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[([ xX])\](?=\s|$)/;
const FENCE = /^[ \t>]*(`{3,}|~{3,})/;
// GitHub's image links carry a token that expires after a few minutes: an open panel loads the description again before that.
const PANEL_REFRESH_INTERVAL = 4 * 60 * 1000;
const PANEL_REFRESH_MIN_GAP = 30 * 1000;

let descriptionMode = "read";
let descriptionView = newDescriptionView("");
let descriptionObserver = null;
let descriptionBodyOwner = null;
let lastPanelRefresh = 0;

function newDescriptionView(key) {
  return {
    key,
    status: "idle",
    error: "",
    html: "",
    body: "",
    editedAt: "",
    editor: "",
    saving: false,
    tasks: null,
    shown: null,
    // Reaction counts of GitHub, the reactions of the connected user, and what the card is showing of them.
    reactions: null,
    mine: new Set(),
    picker: false,
    busy: new Set(),
    reactionsShown: null,
    collapsed: false,
    expanded: false,
    overflowing: false
  };
}

function issueApiBase(issue) {
  const [owner, repository] = repoOf(issue);
  return `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${issue.number}`;
}

// The checkboxes of a Markdown text in reading order, as GitHub renders them: not those of code blocks or HTML comments.
function taskMarkers(markdown) {
  const markers = [];
  let fence = null;
  let inComment = false;
  let offset = 0;
  for (const line of markdown.split("\n")) {
    const lineStartsInComment = inComment;
    inComment = commentStateAfter(line, inComment);
    if (!lineStartsInComment) {
      const fenceMatch = FENCE.exec(line);
      if (fence) {
        if (fenceMatch && fenceMatch[1][0] === fence[0] && fenceMatch[1].length >= fence.length && !line.slice(fenceMatch[0].length).trim()) fence = null;
      } else if (fenceMatch) {
        fence = fenceMatch[1];
      } else {
        const match = TASK_MARKER.exec(line);
        if (match) markers.push({ index: offset + match[1].length + 1, checked: match[2] !== " " });
      }
    }
    offset += line.length + 1;
  }
  return markers;
}

function commentStateAfter(line, inComment) {
  let open = inComment;
  let position = 0;
  while (position < line.length) {
    const edge = line.indexOf(open ? "-->" : "<!--", position);
    if (edge === -1) break;
    open = !open;
    position = edge + (open ? 4 : 3);
  }
  return open;
}

function descriptionIsEdited(issue) {
  return Boolean(descriptionView.editedAt) && Date.parse(descriptionView.editedAt) - Date.parse(issue.created_at) > TIMELINE_EDITED_AFTER;
}

function descriptionDirty(issue) {
  return panelElements.title.value.trim() !== issue.title || descriptionEditor.value !== (issue.body || "");
}

// A new panel starts in read mode for an existing issue, and in edit mode for a new one.
function resetDescription(issue) {
  descriptionMode = issue.draft ? "edit" : "read";
  descriptionView = newDescriptionView("");
}

function ensureDescription(issue) {
  if (issue.draft) return;
  const key = `${issue.id}|${Boolean(accessToken)}`;
  if (descriptionView.key === key) return;
  descriptionView = newDescriptionView(key);
  descriptionView.status = "loading";
  lastPanelRefresh = Date.now();
  loadDescription(issue, descriptionView);
}

// Reloads the rendered description without showing the loading state (after a change of the issue elsewhere).
function refreshDescription() {
  const issue = currentIssue();
  if (issue && !issue.draft && descriptionView.key) loadDescription(issue, descriptionView);
}

async function fetchIssueBody(issue) {
  return githubRequest(issueApiBase(issue), { headers: { Accept: TIMELINE_ACCEPT } }, accessToken);
}

async function loadDescription(issue, view) {
  const [owner, name] = repoOf(issue);
  const edited = accessToken
    ? githubRequest(
        `${API_ROOT}/graphql`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: EDITED_QUERY, variables: { owner, name, number: issue.number } })
        },
        accessToken
      )
        .then((result) => result.data?.repository?.issue || null)
        .catch(() => null)
    : Promise.resolve(null);
  try {
    const fresh = await fetchIssueBody(issue);
    const history = await edited;
    if (descriptionView !== view) return;
    view.html = fresh.body_html || "";
    view.body = fresh.body || "";
    view.editedAt = history?.lastEditedAt || "";
    view.editor = history?.editor?.login || "";
    view.reactions = fresh.reactions || null;
    if (history?.reactionGroups) {
      const groupToRest = new Map(REACTIONS.map((reaction) => [reaction.graphql, reaction.content]));
      view.mine = new Set(history.reactionGroups.filter((group) => group.viewerHasReacted).map((group) => groupToRest.get(group.content)));
    }
    view.status = "ready";
    adoptFreshBody(issue, view.body);
  } catch (error) {
    if (descriptionView !== view) return;
    if (view.status !== "ready") {
      view.status = "error";
      view.error = apiErrorMessage(error);
    }
  }
  const current = currentIssue();
  if (current && current.id === issue.id) renderDescription(current);
}

// The board's copy of the body can be older than GitHub's. In read mode the editor only mirrors it, so it follows.
function adoptFreshBody(issue, body) {
  const current = currentIssue();
  if (!current || current.id !== issue.id || descriptionMode !== "read" || (current.body || "") === body) return;
  current.body = body;
  descriptionEditor.value = body;
}

function bindTaskCheckboxes(container, view) {
  const boxes = [...container.querySelectorAll("input.task-list-item-checkbox")];
  const markers = taskMarkers(view.body);
  // Only when the Markdown and the rendered HTML agree on every checkbox can a click be mapped back to the text.
  const aligned = markers.length === boxes.length && markers.every((marker, index) => marker.checked === boxes[index].checked);
  view.tasks = aligned ? markers : null;
  boxes.forEach((box) => {
    box.disabled = !aligned || !accessToken || view.saving;
  });
}

function renderDescriptionBody(view) {
  const { descBody } = panelElements;
  const shown = `${view.status}|${view.error}|${withoutImageTokens(view.html)}`;
  if (view.shown === shown) {
    // Same text: keep the elements and only renew the image tokens that GitHub signed again.
    if (view.tokenSource !== view.html && descriptionBodyOwner === view) {
      const template = document.createElement("template");
      template.innerHTML = view.html;
      refreshImageTokens(descBody, template.content);
    }
  } else {
    view.shown = shown;
    // Loading the description again must not throw the reader back to the top of a long text.
    const scrollTop = descriptionBodyOwner === view ? descBody.scrollTop : 0;
    descriptionBodyOwner = view;
    if (view.status === "loading" || view.status === "idle") {
      descBody.innerHTML = '<div class="desc-status"><md-circular-progress indeterminate aria-label="Loading description"></md-circular-progress></div>';
    } else if (view.status === "error") {
      descBody.innerHTML = `<p class="tl-empty desc-error" role="alert">Could not load the description: ${escapeHtml(view.error)} <md-text-button class="desc-retry" type="button">Retry</md-text-button></p>`;
    } else if (view.html) {
      descBody.innerHTML = `<div class="tl-comment-body markdown-body">${view.html}</div>`;
      descBody.querySelectorAll("a[href]").forEach((link) => {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      });
      enhanceMarkdownBody(descBody);
    } else {
      descBody.innerHTML = '<p class="tl-empty">No description provided.</p>';
    }
    descBody.scrollTop = scrollTop;
    observeDescriptionSize();
  }
  view.tokenSource = view.html;
  bindTaskCheckboxes(descBody, view);
  updateDescriptionOverflow();
}

// The "show more" fade and button follow the size of the text, which also changes when its images load.
function observeDescriptionSize() {
  const { descBody } = panelElements;
  if (!descriptionObserver) descriptionObserver = new ResizeObserver(updateDescriptionOverflow);
  descriptionObserver.disconnect();
  descriptionObserver.observe(descBody);
  if (descBody.firstElementChild) descriptionObserver.observe(descBody.firstElementChild);
}

function updateDescriptionOverflow() {
  const { descCard, descBody, descWrap, descMore, descExpand } = panelElements;
  const view = descriptionView;
  if (descCard.hidden || view.collapsed) return;
  // Once expanded the text no longer overflows; it keeps the state it had.
  if (!view.expanded) view.overflowing = descBody.scrollHeight > descBody.clientHeight + 1;
  const atEnd = view.expanded || descBody.scrollTop + descBody.clientHeight >= descBody.scrollHeight - 2;
  descWrap.classList.toggle("has-more", view.overflowing && !atEnd);
  descMore.hidden = !view.overflowing;
  descExpand.textContent = view.expanded ? "Collapse description" : "Expand description";
  descExpand.setAttribute("aria-expanded", String(view.expanded));
  if (view.overflowing && !view.expanded) descBody.tabIndex = 0;
  else descBody.removeAttribute("tabindex");
}

function toggleDescriptionExpanded() {
  const view = descriptionView;
  view.expanded = !view.expanded;
  const issue = currentIssue();
  if (issue) renderDescription(issue);
  if (!view.expanded) panelElements.descCard.scrollIntoView({ block: "nearest" });
}

function toggleDescriptionCollapsed() {
  const view = descriptionView;
  view.collapsed = !view.collapsed;
  const issue = currentIssue();
  if (issue) renderDescription(issue);
}

/* ---------- Reactions and link ---------- */

function descriptionReactionsHtml(view) {
  if (view.status !== "ready") return "";
  const counts = view.reactions || {};
  const disabled = accessToken ? "" : "disabled";
  const pills = REACTIONS.filter((reaction) => counts[reaction.content] > 0)
    .map((reaction) => `
      <button type="button" class="tl-reaction${view.mine.has(reaction.content) ? " is-mine" : ""}" data-desc-action="react" data-content="${reaction.content}"
        data-focus-key="react:${reaction.content}" aria-pressed="${view.mine.has(reaction.content)}" title="${reaction.label}" ${disabled}>
        <span aria-hidden="true">${reaction.emoji}</span><span>${counts[reaction.content]}</span>
      </button>`)
    .join("");
  const add = accessToken
    ? `<button type="button" class="tl-reaction tl-reaction-add" data-desc-action="picker" data-focus-key="picker" aria-label="Add reaction" aria-expanded="${view.picker}"><md-icon>add_reaction</md-icon></button>`
    : "";
  const picker = view.picker
    ? `<div class="tl-picker" role="group" aria-label="Pick a reaction">${REACTIONS.map((reaction) => `
        <button type="button" class="tl-reaction" data-desc-action="react" data-content="${reaction.content}" data-focus-key="react:${reaction.content}" title="${reaction.label}" aria-label="${reaction.label}">${reaction.emoji}</button>`).join("")}</div>`
    : "";
  return pills || add ? `<div class="tl-reactions">${pills}${add}</div>${picker}` : "";
}

function renderDescriptionReactions(view) {
  const { descReactions } = panelElements;
  const html = `${descriptionReactionsHtml(view)}|${accessToken ? 1 : 0}`;
  if (view.reactionsShown === html) return;
  view.reactionsShown = html;
  const focusKey = descReactions.contains(document.activeElement) ? document.activeElement.closest("[data-focus-key]")?.dataset.focusKey : null;
  descReactions.innerHTML = descriptionReactionsHtml(view);
  if (focusKey) descReactions.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
}

// POST answers 201 for a new reaction and 200 with the existing one when the user already reacted: that one is removed.
async function toggleDescriptionReaction(content) {
  const issue = currentIssue();
  const view = descriptionView;
  if (!issue || !accessToken || view.busy.has(content)) return;
  view.busy.add(content);
  view.picker = false;
  try {
    const url = `${issueApiBase(issue)}/reactions`;
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
    const mine = new Set(view.mine);
    if (delta > 0) mine.add(content);
    else mine.delete(content);
    view.mine = mine;
    const reactions = { ...view.reactions };
    reactions[content] = Math.max(0, (reactions[content] || 0) + delta);
    reactions.total_count = Math.max(0, (reactions.total_count || 0) + delta);
    view.reactions = reactions;
  } catch (error) {
    showNotice(`Could not change the reaction: ${apiErrorMessage(error)}`, true);
  } finally {
    view.busy.delete(content);
    if (descriptionView === view) renderDescriptionReactions(view);
  }
}

async function copyIssueLink() {
  const issue = currentIssue();
  if (!issue || issue.draft) return;
  try {
    await navigator.clipboard.writeText(issue.html_url);
    showSnackbar("Issue link copied.");
  } catch {
    showNotice("Could not copy the link. Your browser blocked access to the clipboard.", true);
  }
}

/* ---------- Refresh of an open panel ---------- */

function refreshOpenPanel() {
  if (panelIssueId === null || document.hidden || Date.now() - lastPanelRefresh < PANEL_REFRESH_MIN_GAP) return;
  const issue = currentIssue();
  if (!issue || issue.draft) return;
  lastPanelRefresh = Date.now();
  refreshDescription();
  refreshTimeline();
}

function renderDescription(issue) {
  const { pinned, statusSlot, statusRow, heading, descCard, descMeta, descEdit, descToggle, title: titleInput, cancel, save } = panelElements;
  const editing = issue.draft || descriptionMode === "edit";
  // Reading, the status and the title stay above the scrolling column. Editing, they go back in the column with the title field.
  const host = editing ? statusSlot : pinned;
  if (statusRow.parentElement !== host) host.prepend(statusRow);
  pinned.hidden = editing;
  descCard.hidden = editing;
  titleInput.hidden = !editing;
  descriptionEditor.element.hidden = !editing;
  cancel.hidden = !editing || issue.draft;
  save.hidden = !editing;
  if (editing) return;
  heading.textContent = issue.title;
  heading.title = issue.title;
  const edited = descriptionIsEdited(issue);
  const editedBy = descriptionView.editor ? ` by ${descriptionView.editor}` : "";
  const editedAt = descriptionView.editedAt ? ` on ${new Date(descriptionView.editedAt).toLocaleString()}` : "";
  descMeta.innerHTML = `${userHtml(issue.user)} commented ${timeHtml(issue.created_at)}${edited ? ` <span class="tl-edited" title="Edited${escapeHtml(editedBy + editedAt)}">· edited</span>` : ""}`;
  descEdit.hidden = !accessToken;
  const view = descriptionView;
  descCard.classList.toggle("is-collapsed", view.collapsed);
  descCard.classList.toggle("is-expanded", view.expanded);
  descToggle.querySelector("md-icon").textContent = view.collapsed ? "expand_more" : "expand_less";
  descToggle.setAttribute("aria-expanded", String(!view.collapsed));
  const toggleLabel = view.collapsed ? "Expand description" : "Collapse description";
  descToggle.setAttribute("aria-label", toggleLabel);
  descToggle.title = toggleLabel;
  renderDescriptionBody(view);
  renderDescriptionReactions(view);
}

async function onDescriptionCheckbox(event) {
  const box = event.target.closest("input.task-list-item-checkbox");
  if (!box) return;
  const issue = currentIssue();
  const view = descriptionView;
  const boxes = [...panelElements.descBody.querySelectorAll("input.task-list-item-checkbox")];
  const marker = view.tasks?.[boxes.indexOf(box)];
  const checked = box.checked;
  if (!issue || !marker || view.saving) {
    box.checked = !checked;
    return;
  }
  view.saving = true;
  bindTaskCheckboxes(panelElements.descBody, view);
  let updated = null;
  try {
    // Another person may have edited the description since it was loaded; their text must not be overwritten.
    const fresh = await fetchIssueBody(issue);
    if (descriptionView !== view) return;
    if ((fresh.body || "") !== view.body) {
      view.body = fresh.body || "";
      view.html = fresh.body_html || "";
      adoptFreshBody(issue, view.body);
      showPanelError("The description was changed on GitHub. Review the updated version and try again.");
      return;
    }
    const next = `${view.body.slice(0, marker.index)}${checked ? "x" : " "}${view.body.slice(marker.index + 1)}`;
    updated = await patchIssueNow(issue, { body: next });
    if (updated) descriptionEditor.value = updated.body || "";
  } catch (error) {
    showPanelError(`Could not update the checkbox: ${apiErrorMessage(error)}`);
  } finally {
    view.saving = false;
    if (descriptionView === view) {
      if (!updated) view.shown = null;
      const current = currentIssue();
      if (current) renderDescription(current);
    }
  }
}

// Called by patchIssueNow with the body_html of GitHub's answer.
function noteDescriptionSaved(issue, updated, html) {
  const view = descriptionView;
  if (!view.key.startsWith(`${issue.id}|`)) return;
  if ((updated.body || "") !== view.body) {
    view.editedAt = new Date().toISOString();
    view.editor = currentLogin;
  }
  view.body = updated.body || "";
  if (html !== undefined) view.html = html || "";
  view.status = "ready";
}

function startDescriptionEdit() {
  const issue = currentIssue();
  if (!issue || issue.draft || !accessToken) return;
  descriptionMode = "edit";
  panelElements.title.value = issue.title;
  descriptionEditor.value = issue.body || "";
  panelElements.error.hidden = true;
  refreshPanel();
  descriptionEditor.focus({ showStart: true });
}

function finishDescriptionEdit() {
  const issue = currentIssue();
  if (!issue || issue.draft) return;
  descriptionMode = "read";
  panelElements.title.value = issue.title;
  descriptionEditor.value = issue.body || "";
  descriptionEditor.showWrite();
  panelElements.error.hidden = true;
  refreshPanel();
  panelElements.descEdit.focus();
}

async function cancelDescriptionEdit() {
  const issue = currentIssue();
  if (!issue || (descriptionDirty(issue) && !(await confirmDiscard()))) return;
  finishDescriptionEdit();
}

function setupDescriptionCard(panel) {
  panel.querySelector(".desc-edit").addEventListener("click", startDescriptionEdit);
  panelElements.descCopy.addEventListener("click", copyIssueLink);
  panelElements.descToggle.addEventListener("click", toggleDescriptionCollapsed);
  panelElements.descExpand.addEventListener("click", toggleDescriptionExpanded);
  panelElements.descBody.addEventListener("scroll", updateDescriptionOverflow, { passive: true });
  panelElements.descReactions.addEventListener("click", (event) => {
    const target = event.target.closest("[data-desc-action]");
    if (!target) return;
    if (target.dataset.descAction === "picker") {
      descriptionView.picker = !descriptionView.picker;
      renderDescriptionReactions(descriptionView);
    } else {
      toggleDescriptionReaction(target.dataset.content);
    }
  });
  document.addEventListener("visibilitychange", refreshOpenPanel);
  window.addEventListener("focus", refreshOpenPanel);
  setInterval(refreshOpenPanel, PANEL_REFRESH_INTERVAL);
  panel.querySelector(".panel-cancel").addEventListener("click", cancelDescriptionEdit);
  panelElements.descBody.addEventListener("change", onDescriptionCheckbox);
  panelElements.descBody.addEventListener("click", (event) => {
    if (!event.target.closest(".desc-retry")) return;
    const issue = currentIssue();
    if (!issue || issue.draft) return;
    descriptionView = newDescriptionView(`${issue.id}|${Boolean(accessToken)}`);
    descriptionView.status = "loading";
    renderDescription(issue);
    loadDescription(issue, descriptionView);
  });
}
