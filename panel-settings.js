// Side panel settings that need their own data or popovers: assignees, development and relationships.
// Loaded before app.js; it relies on globals declared there (accessToken, githubRequest, issues, panelMeta…).

const MAX_ASSIGNEES = 10;
const RELATION_KINDS = [
  { key: "parent", title: "Parent", addText: "Add parent", icon: "arrow_upward" },
  { key: "subIssues", title: "Sub-issues", addText: "Add sub-issue", icon: "subdirectory_arrow_right" },
  { key: "blockedBy", title: "Blocked by", addText: "Mark as blocked by", icon: "block" },
  { key: "blocking", title: "Blocking", addText: "Mark as blocking", icon: "priority_high" }
];
const DEVELOPMENT_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      closedByPullRequestsReferences(first: 25, includeClosedPrs: true) {
        nodes { number title url state isDraft repository { nameWithOwner } }
      }
      linkedBranches(first: 25) { nodes { ref { name repository { nameWithOwner } } } }
    }
  }
}`;
const PICKER_SEARCH_DELAY = 300;

let panelExtras = newPanelExtras("");
let picker = null;

function emptyRelations() {
  return { parent: null, subIssues: [], blockedBy: [], blocking: [] };
}

function relationCount(relations) {
  return (relations.parent ? 1 : 0) + relations.subIssues.length + relations.blockedBy.length + relations.blocking.length;
}

function newPanelExtras(key) {
  return {
    key,
    relationsStatus: "idle",
    relationsError: "",
    relations: emptyRelations(),
    developmentStatus: "idle",
    developmentError: "",
    pulls: [],
    branches: []
  };
}

function resetPanelExtras() {
  panelExtras = newPanelExtras("");
}

function relationItem(raw) {
  return {
    id: raw.id,
    number: raw.number,
    title: raw.title,
    state: raw.state,
    repo: raw.repository_url.split("/").slice(-2).join("/"),
    url: raw.html_url
  };
}

function issueApiUrl(repo, number) {
  return `${API_ROOT}/repos/${repo.split("/").map(encodeURIComponent).join("/")}/issues/${number}`;
}

function ensurePanelExtras(issue) {
  const key = `${issue.id}|${Boolean(accessToken)}`;
  if (panelExtras.key === key) return;
  panelExtras = newPanelExtras(key);
  if (issue.draft) {
    panelExtras.relationsStatus = "ready";
    panelExtras.relations = issue.relationships;
    return;
  }
  panelExtras.relationsStatus = "loading";
  loadRelations(issue, key);
  if (accessToken) {
    panelExtras.developmentStatus = "loading";
    loadDevelopment(issue, key);
  }
}

async function loadRelations(issue, key) {
  const base = issueApiUrl(repoOf(issue).join("/"), issue.number);
  const list = (path) => fetchAllPages(`${base}${path}`).then((items) => items.map(relationItem));
  const parent = githubRequest(`${base}/parent`, {}, accessToken).then(relationItem).catch((error) => {
    if (error.status === 404) return null;
    throw error;
  });
  try {
    const [parentIssue, subIssues, blockedBy, blocking] = await Promise.all([
      parent,
      list("/sub_issues"),
      list("/dependencies/blocked_by"),
      list("/dependencies/blocking")
    ]);
    if (panelExtras.key !== key) return;
    panelExtras.relations = { parent: parentIssue, subIssues, blockedBy, blocking };
    panelExtras.relationsStatus = "ready";
  } catch (error) {
    if (panelExtras.key !== key) return;
    panelExtras.relationsStatus = "error";
    panelExtras.relationsError = apiErrorMessage(error);
  }
  renderPanelControls();
}

async function loadDevelopment(issue, key) {
  const [owner, name] = repoOf(issue);
  try {
    const result = await githubRequest(
      `${API_ROOT}/graphql`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: DEVELOPMENT_QUERY, variables: { owner, name, number: issue.number } })
      },
      accessToken
    );
    if (result.errors?.length) throw new Error(result.errors[0].message);
    if (panelExtras.key !== key) return;
    const data = result.data.repository.issue;
    panelExtras.pulls = data.closedByPullRequestsReferences.nodes.map((node) => ({
      number: node.number,
      title: node.title,
      url: node.url,
      state: node.isDraft && node.state === "OPEN" ? "DRAFT" : node.state,
      repo: node.repository.nameWithOwner
    }));
    panelExtras.branches = data.linkedBranches.nodes
      .filter((node) => node.ref)
      .map((node) => ({ name: node.ref.name, repo: node.ref.repository.nameWithOwner }));
    panelExtras.developmentStatus = "ready";
  } catch (error) {
    if (panelExtras.key !== key) return;
    panelExtras.developmentStatus = "error";
    panelExtras.developmentError = apiErrorMessage(error);
  }
  renderPanelControls();
}

function withRelation(relations, kind, item, adding) {
  const next = { ...relations };
  if (kind === "parent") {
    next.parent = adding ? item : null;
    return next;
  }
  next[kind] = relations[kind].filter((existing) => existing.id !== item.id);
  if (adding) next[kind].push(item);
  return next;
}

function sendRelationRequest(method, url, body) {
  const options = { method };
  if (body) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }
  return githubRequest(url, options, accessToken);
}

function mutateRelation(issue, kind, item, adding) {
  const own = { id: issue.id, url: issueApiUrl(repoOf(issue).join("/"), issue.number) };
  const other = { id: item.id, url: issueApiUrl(item.repo, item.number) };
  const method = adding ? "POST" : "DELETE";
  switch (kind) {
    case "parent":
      return adding
        ? sendRelationRequest("POST", `${other.url}/sub_issues`, { sub_issue_id: own.id, replace_parent: true })
        : sendRelationRequest("DELETE", `${other.url}/sub_issue`, { sub_issue_id: own.id });
    case "subIssues":
      return sendRelationRequest(method, `${own.url}/${adding ? "sub_issues" : "sub_issue"}`, { sub_issue_id: other.id });
    case "blockedBy":
      return adding
        ? sendRelationRequest("POST", `${own.url}/dependencies/blocked_by`, { issue_id: other.id })
        : sendRelationRequest("DELETE", `${own.url}/dependencies/blocked_by/${other.id}`);
    default:
      return adding
        ? sendRelationRequest("POST", `${other.url}/dependencies/blocked_by`, { issue_id: own.id })
        : sendRelationRequest("DELETE", `${other.url}/dependencies/blocked_by/${own.id}`);
  }
}

async function changeRelation(issue, kind, item, adding) {
  if (!accessToken) {
    openAuthDialog();
    return;
  }
  if (issue.draft) {
    issue.relationships = withRelation(issue.relationships, kind, item, adding);
    panelExtras.relations = issue.relationships;
    renderPanelControls();
    return;
  }
  panelElements.error.hidden = true;
  panelExtras.relations = withRelation(panelExtras.relations, kind, item, adding);
  renderPanelControls();
  queueRelationJob(issue, kind, item, adding, panelExtras.key);
}

// Relationship changes show instantly and are sent in order in the background.
// After a failure, the relationships are reloaded once the queue is empty.
let relationQueue = Promise.resolve();
let relationJobs = 0;
let relationReload = null;

function queueRelationJob(issue, kind, item, adding, key) {
  relationJobs += 1;
  relationQueue = relationQueue.then(async () => {
    try {
      await mutateRelation(issue, kind, item, adding);
      clearIssuesCache();
    } catch (error) {
      const message = `Could not update the relationships of ${repoOf(issue)[1]}#${issue.number}: ${apiErrorMessage(error)}`;
      relationReload = { issue, key };
      if (panelExtras.key === key) showPanelError(message);
      else showNotice(message, true);
    } finally {
      relationJobs -= 1;
      if (relationJobs === 0 && relationReload) {
        const reload = relationReload;
        relationReload = null;
        if (panelExtras.key === reload.key) loadRelations(reload.issue, reload.key);
      }
    }
  });
}

async function applyDraftRelationships(created, relations) {
  const jobs = RELATION_KINDS.flatMap(({ key }) => (key === "parent" ? (relations.parent ? [[key, relations.parent]] : []) : relations[key].map((item) => [key, item])));
  const failures = [];
  for (const [kind, item] of jobs) {
    try {
      await mutateRelation(created, kind, item, true);
    } catch (error) {
      failures.push(`${item.repo}#${item.number} (${apiErrorMessage(error)})`);
    }
  }
  return failures;
}

// A section whose heading is a button (title and gear) opens a picker, as on GitHub.
function sectionHtml(title, trigger, body) {
  const heading = trigger
    ? `<h3 class="section-heading"><button type="button" class="section-trigger" data-picker="${trigger.key}" aria-haspopup="dialog" ${trigger.disabled}><md-ripple></md-ripple><md-focus-ring></md-focus-ring><span>${title}</span><md-icon>settings</md-icon></button></h3>`
    : `<h3 class="section-heading">${title}</h3>`;
  return `
    <section class="other-section">
      ${heading}
      ${body}
    </section>`;
}

function assigneesSectionHtml(issue, disabled) {
  const assigned = issue.assignees || [];
  let body;
  if (assigned.length === 0) {
    const canAssignSelf = currentLogin && (panelMeta.assignees || []).some((user) => user.login === currentLogin);
    body = `<p class="empty-note">No one${canAssignSelf ? ' <md-text-button class="assign-self" ' + disabled + ">Assign yourself</md-text-button>" : ""}</p>`;
  } else {
    body = `<ul class="person-list">${assigned.map((user) => `
      <li><a class="person" href="https://github.com/${encodeURIComponent(user.login)}" target="_blank" rel="noopener">
        <img class="avatar" src="${escapeHtml(user.avatar_url)}" alt="" width="24" height="24"><span>${escapeHtml(user.login)}</span></a></li>`).join("")}</ul>`;
  }
  return sectionHtml("Assignees", { key: "assignees", disabled }, body);
}

const PULL_STATES = {
  OPEN: { icon: "merge_type", text: "Open", className: "state-open" },
  DRAFT: { icon: "merge_type", text: "Draft", className: "state-draft" },
  MERGED: { icon: "merge", text: "Merged", className: "state-merged" },
  CLOSED: { icon: "merge_type", text: "Closed", className: "state-closed" }
};

function branchUrl(branch) {
  return `https://github.com/${branch.repo}/tree/${branch.name.split("/").map(encodeURIComponent).join("/")}`;
}

function developmentSectionHtml(issue) {
  const { developmentStatus, pulls, branches } = panelExtras;
  let body;
  if (issue.draft) body = '<p class="empty-note">Linked pull requests and branches appear once the issue is created.</p>';
  else if (!accessToken) body = '<p class="empty-note">Connect GitHub to see linked pull requests and branches.</p>';
  else if (developmentStatus === "loading") body = '<md-circular-progress indeterminate aria-label="Loading development"></md-circular-progress>';
  else if (developmentStatus === "error") body = `<p class="empty-note">Could not load development: ${escapeHtml(panelExtras.developmentError)}</p>`;
  else if (pulls.length === 0 && branches.length === 0) body = '<p class="empty-note">No branches or pull requests.</p>';
  else {
    const pullRows = pulls.map((pull) => {
      const state = PULL_STATES[pull.state] || PULL_STATES.OPEN;
      return `
        <li class="relation-row">
          <md-icon class="${state.className}" title="${state.text}">${state.icon}</md-icon>
          <a href="${escapeHtml(pull.url)}" target="_blank" rel="noopener"><span class="relation-title">${escapeHtml(pull.title)}</span>
            <span class="relation-ref">${escapeHtml(pull.repo)}#${pull.number} · ${state.text}</span></a>
        </li>`;
    });
    const branchRows = branches.map((branch) => `
        <li class="relation-row">
          <md-icon>call_split</md-icon>
          <a href="${escapeHtml(branchUrl(branch))}" target="_blank" rel="noopener"><span class="relation-title">${escapeHtml(branch.name)}</span>
            <span class="relation-ref">${escapeHtml(branch.repo)}</span></a>
        </li>`);
    body = `<ul class="relation-list">${[...pullRows, ...branchRows].join("")}</ul>`;
  }
  return sectionHtml("Development", null, body);
}

function relationRowHtml(kind, item, disabled) {
  const closed = item.state === "closed";
  return `
    <li class="relation-row">
      <md-icon class="${closed ? "state-merged" : "state-open"}" title="${closed ? "Closed" : "Open"}">${closed ? "check_circle" : "adjust"}</md-icon>
      <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener"><span class="relation-title">${escapeHtml(item.title)}</span>
        <span class="relation-ref">${escapeHtml(item.repo)}#${item.number}</span></a>
      <md-icon-button class="relation-remove" data-remove-kind="${kind}" data-remove-id="${item.id}" aria-label="Remove ${escapeHtml(item.repo)}#${item.number}" ${disabled}><md-icon>close</md-icon></md-icon-button>
    </li>`;
}

function relationshipsSectionHtml(issue, disabled) {
  const { relationsStatus, relations } = panelExtras;
  let body;
  if (relationsStatus === "loading") body = '<md-circular-progress indeterminate aria-label="Loading relationships"></md-circular-progress>';
  else if (relationsStatus === "error") body = `<p class="empty-note">Could not load relationships: ${escapeHtml(panelExtras.relationsError)}</p>`;
  else if (relationCount(relations) === 0) body = '<p class="empty-note">None yet.</p>';
  else {
    body = RELATION_KINDS.map(({ key, title }) => {
      const items = key === "parent" ? (relations.parent ? [relations.parent] : []) : relations[key];
      if (items.length === 0) return "";
      return `<div class="relation-group"><h4>${title}</h4><ul class="relation-list">${items.map((item) => relationRowHtml(key, item, disabled)).join("")}</ul></div>`;
    }).join("");
  }
  const locked = relationsStatus === "loading" || relationsStatus === "error" ? "disabled" : disabled;
  return sectionHtml("Relationships", { key: "relationships", disabled: locked }, body);
}

function bindSettingsSections(controls, issue) {
  controls.querySelectorAll("[data-picker]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.picker;
      if (picker && picker.anchorKey === key) {
        closePicker();
        return;
      }
      openPicker(key === "assignees" ? assigneePickerConfig() : relationKindPickerConfig());
    });
  });
  controls.querySelector(".assign-self")?.addEventListener("click", () => {
    const own = (panelMeta.assignees || []).find((user) => user.login === currentLogin);
    if (own) patchIssue(issue, { assignees: [own.login] });
  });
  controls.querySelectorAll("[data-remove-kind]").forEach((button) => {
    button.addEventListener("click", () => {
      const kind = button.dataset.removeKind;
      const items = kind === "parent" ? [panelExtras.relations.parent] : panelExtras.relations[kind];
      const item = items.find((candidate) => candidate && String(candidate.id) === button.dataset.removeId);
      if (item) changeRelation(currentIssue(), kind, item, false);
    });
  });
}

// Pickers: a GitHub-style popover with a search field and a list of choices.
// config: { anchorKey, title, hint, placeholder, live, load(query), remote(query), isSelected(item),
//           onSelect(item), clearText, onClear }
// An item is { key, headline, supporting, avatarUrl, icon, iconClass }.
// onSelect may return "close" or a new config to replace the current popover.

function pickerAnchor() {
  return picker && panelElements.controls.querySelector(`[data-picker="${picker.anchorKey}"]`);
}

function openPicker(config) {
  closePicker(false);
  const element = document.createElement("div");
  element.className = "picker";
  element.setAttribute("role", "dialog");
  element.setAttribute("aria-label", config.title);
  element.innerHTML = `
    <header class="picker-header">
      <h4>${escapeHtml(config.title)}</h4>
      <md-icon-button class="picker-close" aria-label="Close"><md-icon>close</md-icon></md-icon-button>
    </header>
    ${config.hint ? `<p class="picker-hint">${escapeHtml(config.hint)}</p>` : ""}
    ${config.placeholder ? `<md-outlined-text-field class="picker-search" label="${escapeHtml(config.placeholder)}" type="search" autocomplete="off"><md-icon slot="leading-icon">search</md-icon></md-outlined-text-field>` : ""}
    ${config.clearText ? `<md-text-button class="picker-clear">${escapeHtml(config.clearText)}</md-text-button>` : ""}
    <md-list class="picker-list"></md-list>`;
  document.body.append(element);

  const state = {
    config,
    element,
    anchorKey: config.anchorKey,
    items: [],
    loading: true,
    runId: 0,
    timer: 0,
    search: element.querySelector(".picker-search"),
    list: element.querySelector(".picker-list")
  };
  picker = state;

  state.onOutside = (event) => {
    if (element.contains(event.target) || event.target.closest?.(`[data-picker="${state.anchorKey}"]`)) return;
    closePicker(false);
  };
  state.onViewport = (event) => {
    if (!element.contains(event.target)) positionPicker();
  };
  document.addEventListener("pointerdown", state.onOutside, true);
  window.addEventListener("scroll", state.onViewport, true);
  window.addEventListener("resize", positionPicker);

  element.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closePicker();
    } else if (event.key === "ArrowDown" && event.target === state.search) {
      event.preventDefault();
      state.list.querySelector("md-list-item")?.focus();
    }
  });
  element.querySelector(".picker-close").addEventListener("click", () => closePicker());
  element.querySelector(".picker-clear")?.addEventListener("click", () => config.onClear());
  state.search?.addEventListener("input", () => refreshPicker(true));
  state.list.addEventListener("click", async (event) => {
    const row = event.target.closest("md-list-item");
    if (!row || panelBusy) return;
    const result = await config.onSelect(state.items[Number(row.dataset.index)]);
    if (picker !== state) return;
    if (result === "close") closePicker();
    else if (result) openPicker({ ...result, anchorKey: config.anchorKey });
  });

  positionPicker();
  refreshPicker(true);
  customElements.whenDefined("md-outlined-text-field").then(() => (state.search || element.querySelector("md-list-item"))?.focus());
}

function positionPicker() {
  const anchor = pickerAnchor();
  if (!anchor) return;
  const { element } = picker;
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(360, window.innerWidth - 16);
  const below = window.innerHeight - rect.bottom - 12;
  const above = rect.top - 12;
  const openAbove = below < 280 && above > below;
  element.style.width = `${width}px`;
  element.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
  element.style.top = openAbove ? "auto" : `${rect.bottom + 4}px`;
  element.style.bottom = openAbove ? `${window.innerHeight - rect.top + 4}px` : "auto";
  element.style.maxHeight = `${Math.min(480, openAbove ? above : below)}px`;
}

function closePicker(restoreFocus = true) {
  if (!picker) return;
  const anchor = restoreFocus ? pickerAnchor() : null;
  document.removeEventListener("pointerdown", picker.onOutside, true);
  window.removeEventListener("scroll", picker.onViewport, true);
  window.removeEventListener("resize", positionPicker);
  clearTimeout(picker.timer);
  picker.element.remove();
  picker = null;
  anchor?.focus();
}

function renderPickerList() {
  const { config, items, list, loading } = picker;
  if (loading && items.length === 0) {
    list.innerHTML = '<div class="picker-empty"><md-circular-progress indeterminate aria-label="Loading"></md-circular-progress></div>';
    return;
  }
  if (items.length === 0) {
    list.innerHTML = '<p class="picker-empty empty-note">No results.</p>';
    return;
  }
  list.innerHTML = items.map((item, index) => {
    const lead = item.avatarUrl
      ? `<img slot="start" class="avatar" src="${escapeHtml(item.avatarUrl)}" alt="" width="32" height="32">`
      : `<md-icon slot="start" class="${item.iconClass || ""}">${item.icon || "circle"}</md-icon>`;
    const trail = config.isSelected(item) ? '<md-icon slot="end" class="picker-check">check</md-icon>' : "";
    return `<md-list-item type="button" data-index="${index}" ${config.isSelected(item) ? 'aria-current="true"' : ""}>${lead}
      <div slot="headline">${escapeHtml(item.headline)}</div>
      ${item.supporting ? `<div slot="supporting-text">${escapeHtml(item.supporting)}</div>` : ""}${trail}</md-list-item>`;
  }).join("");
}

async function refreshPicker(reload) {
  if (!picker) return;
  const state = picker;
  if (!reload) {
    renderPickerList();
    return;
  }
  const query = state.search ? state.search.value.trim() : "";
  const run = ++state.runId;
  clearTimeout(state.timer);
  state.items = await state.config.load(query);
  if (picker !== state || run !== state.runId) return;
  state.loading = false;
  renderPickerList();
  if (state.config.remote && query) {
    state.loading = true;
    state.timer = setTimeout(async () => {
      try {
        const remote = await state.config.remote(query);
        if (picker !== state || run !== state.runId) return;
        const known = new Set(state.items.map((item) => item.key));
        state.items = [...state.items, ...remote.filter((item) => !known.has(item.key))];
      } catch {
        // Local matches remain available when the search fails or is rate limited.
      }
      if (picker !== state || run !== state.runId) return;
      state.loading = false;
      renderPickerList();
    }, PICKER_SEARCH_DELAY);
  }
}

function assigneePickerConfig() {
  const pinned = new Set((currentIssue().assignees || []).map((user) => user.login));
  return {
    anchorKey: "assignees",
    title: "Assign to",
    hint: `Assign up to ${MAX_ASSIGNEES} people to this issue`,
    placeholder: "Type or choose a user",
    live: true,
    clearText: "Clear assignees",
    load: (query) => {
      if (panelMeta.assignees === null) return [];
      const issue = currentIssue();
      const users = [...panelMeta.assignees];
      for (const user of issue.assignees || []) if (!users.some((item) => item.login === user.login)) users.push(user);
      const needle = query.toLowerCase();
      return users
        .filter((user) => user.login.toLowerCase().includes(needle))
        .sort((a, b) => Number(pinned.has(b.login)) - Number(pinned.has(a.login)))
        .map((user) => ({ key: user.login, headline: user.login, avatarUrl: user.avatar_url }));
    },
    isSelected: (item) => (currentIssue().assignees || []).some((user) => user.login === item.key),
    onSelect: async (item) => {
      const issue = currentIssue();
      const current = (issue.assignees || []).map((user) => user.login);
      if (current.includes(item.key)) await patchIssue(issue, { assignees: current.filter((name) => name !== item.key) });
      else if (current.length >= MAX_ASSIGNEES) showPanelError(`An issue can have up to ${MAX_ASSIGNEES} assignees.`);
      else await patchIssue(issue, { assignees: [...current, item.key] });
    },
    onClear: async () => {
      await patchIssue(currentIssue(), { assignees: [] });
    }
  };
}

function relationKindPickerConfig() {
  return {
    anchorKey: "relationships",
    title: "Add relationship",
    live: true,
    load: () => RELATION_KINDS.map((kind) => ({ key: kind.key, headline: kind.addText, icon: kind.icon })),
    isSelected: () => false,
    onSelect: (item) => relationIssuePickerConfig(item.key)
  };
}

function relationIssuePickerConfig(kind) {
  const spec = RELATION_KINDS.find((item) => item.key === kind);
  const toPickerItem = (item) => ({
    key: String(item.id),
    headline: item.title,
    supporting: `${item.repo}#${item.number}`,
    icon: item.state === "closed" ? "check_circle" : "adjust",
    iconClass: item.state === "closed" ? "state-merged" : "state-open",
    issue: item
  });
  const current = () => (kind === "parent" ? [panelExtras.relations.parent] : panelExtras.relations[kind]).filter(Boolean);
  const ownId = currentIssue().id;
  return {
    anchorKey: "relationships",
    title: spec.addText,
    hint: `Search ${ORGANIZATION} issues by title or number`,
    placeholder: "Search issues",
    load: (query) => {
      const needle = query.toLowerCase().replace(/^#/, "");
      return issues
        .filter((issue) => issue.id !== ownId && !issue.pull_request)
        .filter((issue) => !needle || issue.title.toLowerCase().includes(needle) || String(issue.number) === needle)
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at))
        .slice(0, 30)
        .map((issue) => toPickerItem(relationItem(issue)));
    },
    remote: async (query) => {
      const search = encodeURIComponent(`org:${ORGANIZATION} is:issue ${query}`);
      const result = await githubRequest(`${API_ROOT}/search/issues?q=${search}&per_page=20`, {}, accessToken);
      return result.items.filter((issue) => issue.id !== ownId).map((issue) => toPickerItem(relationItem(issue)));
    },
    isSelected: (item) => current().some((existing) => existing.id === item.issue.id),
    onSelect: (item) => {
      changeRelation(currentIssue(), kind, item.issue, !current().some((existing) => existing.id === item.issue.id));
      return "close";
    }
  };
}
