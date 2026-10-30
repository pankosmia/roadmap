// Description card of the side panel: the opening message of an existing issue is shown as on GitHub (author, date,
// "edited", rendered Markdown with clickable task-list checkboxes) and only becomes editable on demand.
// Loaded before app.js; it relies on globals declared there and in timeline.js (githubRequest, currentIssue, TIMELINE_ACCEPT…).

const EDITED_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) { lastEditedAt editor { login } }
  }
}`;
// A task list item: optional quote marks, a list marker, then "[ ]" or "[x]". `[` follows the captured prefix.
const TASK_MARKER = /^([ \t>]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[([ xX])\](?=\s|$)/;
const FENCE = /^[ \t>]*(`{3,}|~{3,})/;

let descriptionMode = "read";
let descriptionView = newDescriptionView("");

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
    shown: null
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
  const shown = `${view.status}|${view.error}|${view.html}`;
  if (view.shown !== shown) {
    view.shown = shown;
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
    } else {
      descBody.innerHTML = '<p class="tl-empty">No description provided.</p>';
    }
  }
  bindTaskCheckboxes(descBody, view);
}

function renderDescription(issue) {
  const { heading, descCard, descMeta, descEdit, title: titleInput, cancel, save } = panelElements;
  const editing = issue.draft || descriptionMode === "edit";
  heading.hidden = editing;
  descCard.hidden = editing;
  titleInput.hidden = !editing;
  descriptionEditor.element.hidden = !editing;
  cancel.hidden = !editing || issue.draft;
  save.hidden = !editing;
  if (editing) return;
  heading.textContent = issue.title;
  const edited = descriptionIsEdited(issue);
  const editedBy = descriptionView.editor ? ` by ${descriptionView.editor}` : "";
  const editedAt = descriptionView.editedAt ? ` on ${new Date(descriptionView.editedAt).toLocaleString()}` : "";
  descMeta.innerHTML = `${userHtml(issue.user)} commented ${timeHtml(issue.created_at)}${edited ? ` <span class="tl-edited" title="Edited${escapeHtml(editedBy + editedAt)}">· edited</span>` : ""}`;
  descEdit.hidden = !accessToken;
  renderDescriptionBody(descriptionView);
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
  descriptionEditor.focus();
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
