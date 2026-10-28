// Board filters: Assignee and Repository chips, and the View menu that resets or saves them.
// Loaded before app.js; it relies on globals declared there (issues, detailVersion, renderBoard, escapeHtml…).
// The filters and the saved views are shared by every page through one localStorage entry.

const FILTERS_KEY = "roadmap-filters";
const NO_ASSIGNEE = "__none__";
const MAX_VIEW_NAME_LENGTH = 40;

let filterState = loadFilterState();
let filterUi = null;
let filterOptionsKey = "";

function stringList(value) {
  return Array.isArray(value) ? [...new Set(value.filter((item) => typeof item === "string"))] : [];
}

function loadFilterState() {
  const state = { current: { assignees: [], repos: [] }, views: [], activeViewId: null };
  try {
    const saved = JSON.parse(localStorage.getItem(FILTERS_KEY));
    if (!saved || typeof saved !== "object") return state;
    state.current = { assignees: stringList(saved.current?.assignees), repos: stringList(saved.current?.repos) };
    for (const view of Array.isArray(saved.views) ? saved.views : []) {
      if (typeof view?.id !== "string" || typeof view?.name !== "string") continue;
      state.views.push({ id: view.id, name: view.name, assignees: stringList(view.assignees), repos: stringList(view.repos) });
    }
    state.activeViewId = state.views.some((view) => view.id === saved.activeViewId) ? saved.activeViewId : null;
  } catch {
    // Unreadable storage leaves the default, unfiltered view.
  }
  return state;
}

function saveFilterState() {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filterState));
  } catch {
    // Storage may be unavailable; the filters then last only for this page view.
  }
}

function activeView() {
  return filterState.views.find((view) => view.id === filterState.activeViewId) || null;
}

function sameList(first, second) {
  return first.length === second.length && first.every((item) => second.includes(item));
}

function hasActiveFilters() {
  return filterState.current.assignees.length > 0 || filterState.current.repos.length > 0;
}

// The badge compares the chips with the view that was active before they were touched (the default view is unfiltered).
function filtersDiffer() {
  const base = activeView() || { assignees: [], repos: [] };
  return !sameList(filterState.current.assignees, base.assignees) || !sameList(filterState.current.repos, base.repos);
}

function matchesFilters(issue) {
  const { assignees, repos } = filterState.current;
  if (assignees.length > 0) {
    const logins = (issue.assignees || []).map((user) => user.login);
    const matches = logins.length > 0 ? logins.some((login) => assignees.includes(login)) : assignees.includes(NO_ASSIGNEE);
    if (!matches) return false;
  }
  return repos.length === 0 || repos.includes(repoOf(issue)[1]);
}

// A parent stays visible when it or one of its sub-issues matches; a nested sub-issue follows its parent.
function passesFilters(issue) {
  if (!hasActiveFilters()) return true;
  if (isNestedSubIssue(issue)) {
    const parent = issues.find((item) => item.url === issue.parent_issue_url);
    return parent ? passesFilters(parent) : false;
  }
  return matchesFilters(issue) || subIssuesOf(issue).some(matchesFilters);
}

function filterOptions() {
  const assignees = new Map();
  const repos = new Map();
  let unassigned = 0;
  for (const issue of issues) {
    if (!isOnBoard(issue) || (detailVersion && issueVersion(issue) !== detailVersion)) continue;
    const repo = repoOf(issue)[1];
    repos.set(repo, (repos.get(repo) || 0) + 1);
    if (!issue.assignees || issue.assignees.length === 0) unassigned += 1;
    for (const user of issue.assignees || []) {
      const entry = assignees.get(user.login) || { value: user.login, text: user.login, avatar: user.avatar_url, count: 0 };
      entry.count += 1;
      assignees.set(user.login, entry);
    }
  }
  // A saved selection that no longer matches any issue stays listed so it can be deselected.
  for (const login of filterState.current.assignees) {
    if (login !== NO_ASSIGNEE && !assignees.has(login)) assignees.set(login, { value: login, text: login, avatar: "", count: 0 });
  }
  for (const repo of filterState.current.repos) {
    if (!repos.has(repo)) repos.set(repo, 0);
  }
  const byText = (first, second) => first.text.localeCompare(second.text, undefined, { sensitivity: "base" });
  const assigneeOptions = [...assignees.values()].sort(byText);
  if (unassigned > 0 || filterState.current.assignees.includes(NO_ASSIGNEE)) {
    assigneeOptions.unshift({ value: NO_ASSIGNEE, text: "Unassigned", avatar: "", count: unassigned });
  }
  const repoOptions = [...repos].map(([name, count]) => ({ value: name, text: name, avatar: "", count })).sort(byText);
  return { assignees: assigneeOptions, repos: repoOptions };
}

function filterItemHtml(kind, option) {
  const avatar = option.avatar ? `<img class="avatar" src="${escapeHtml(option.avatar)}" alt="" width="24" height="24" loading="lazy">` : "";
  return `
    <md-menu-item keep-open data-filter="${kind}" data-value="${escapeHtml(option.value)}">
      <md-checkbox slot="start" touch-target="none" tabindex="-1" aria-hidden="true"></md-checkbox>
      <div slot="headline" class="filter-option">${avatar}<span>${escapeHtml(option.text)}</span></div>
      <div slot="trailing-supporting-text">${option.count}</div>
    </md-menu-item>`;
}

// Rebuilds the menus only when the list of options changed, so an open menu is not disturbed.
function refreshFilterOptions() {
  if (!filterUi) return;
  const options = filterOptions();
  const key = JSON.stringify(options);
  if (key === filterOptionsKey) return;
  filterOptionsKey = key;
  filterUi.options = options;
  filterUi.assigneeMenu.innerHTML = options.assignees.map((option) => filterItemHtml("assignees", option)).join("") || '<p class="filter-empty">No assignees</p>';
  renderRepoItems();
}

// The repository menu keeps its search field as first child; only the items after it are rebuilt.
function renderRepoItems() {
  const needle = (filterUi.repoSearch.value || "").trim().toLowerCase();
  const matches = filterUi.options.repos.filter((option) => option.text.toLowerCase().includes(needle));
  const empty = needle ? "No matching repositories" : "No repositories";
  filterUi.repoMenu.querySelectorAll("md-menu-item, .filter-empty").forEach((node) => node.remove());
  filterUi.repoMenu.insertAdjacentHTML("beforeend", matches.map((option) => filterItemHtml("repos", option)).join("") || `<p class="filter-empty">${empty}</p>`);
  syncFilterBar();
}

function chipLabel(title, kind) {
  const selected = filterState.current[kind];
  if (selected.length === 0) return title;
  const names = filterUi.options[kind === "assignees" ? "assignees" : "repos"];
  const text = (value) => names.find((option) => option.value === value)?.text || value;
  return `${title}: ${selected.length === 1 ? text(selected[0]) : selected.length}`;
}

function syncFilterBar() {
  if (!filterUi) return;
  for (const [kind, chip, title] of [["assignees", filterUi.assigneeChip, "Assignee"], ["repos", filterUi.repoChip, "Repository"]]) {
    const label = chipLabel(title, kind);
    chip.querySelector(".chip-label").textContent = label;
    chip.selected = filterState.current[kind].length > 0;
    chip.setAttribute("aria-label", `${title} filter, ${filterState.current[kind].length} selected`);
  }
  for (const item of filterUi.bar.querySelectorAll("md-menu-item[data-filter]")) {
    item.querySelector("md-checkbox").checked = filterState.current[item.dataset.filter].includes(item.dataset.value);
  }
  const differs = filtersDiffer();
  filterUi.viewBadge.hidden = !differs;
  filterUi.viewButton.setAttribute("aria-label", differs ? "View, filters differ from the current view" : "View");
}

function filtersChanged() {
  saveFilterState();
  refreshFilterOptions();
  syncFilterBar();
  if (issues.length > 0) {
    renderBoard();
    summary.textContent = summaryText();
  }
}

function toggleFilterValue(kind, value) {
  const list = filterState.current[kind];
  filterState.current[kind] = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  filtersChanged();
}

function viewSummary(view) {
  const parts = [];
  if (view.assignees.length > 0) parts.push(`${view.assignees.length} ${view.assignees.length === 1 ? "assignee" : "assignees"}`);
  if (view.repos.length > 0) parts.push(`${view.repos.length} ${view.repos.length === 1 ? "repository" : "repositories"}`);
  return parts.join(" · ") || "No filters";
}

function renderViewMenu() {
  const active = activeView();
  const differs = filtersDiffer();
  // The actions made available by a pending difference carry the same dot as the View button.
  const badgedIcon = (icon) => `<span slot="start" class="icon-badge"><md-icon>${icon}</md-icon><span class="view-badge" aria-hidden="true"></span></span>`;
  const check = (visible) => `<md-icon slot="start" class="view-check" ${visible ? "" : "hidden"}>check</md-icon>`;
  const views = filterState.views
    .map(
      (view) => `
    <md-menu-item data-view-id="${escapeHtml(view.id)}" data-view-action="apply">
      ${check(view.id === filterState.activeViewId)}
      <div slot="headline">${escapeHtml(view.name)}</div>
      <div slot="supporting-text">${escapeHtml(viewSummary(view))}</div>
      <md-icon-button slot="end" data-view-id="${escapeHtml(view.id)}" data-view-action="rename" aria-label="Rename ${escapeHtml(view.name)}" title="Rename"><md-icon>edit</md-icon></md-icon-button>
      <md-icon-button slot="end" data-view-id="${escapeHtml(view.id)}" data-view-action="delete" aria-label="Delete ${escapeHtml(view.name)}" title="Delete"><md-icon>delete</md-icon></md-icon-button>
    </md-menu-item>`
    )
    .join("");
  filterUi.viewMenu.innerHTML = `
    <md-menu-item data-view-action="default">
      ${check(!active)}
      <div slot="headline">Default view</div>
      <div slot="supporting-text">All issues, no filters</div>
    </md-menu-item>
    ${views ? `<md-divider role="separator"></md-divider>${views}` : ""}
    <md-divider role="separator"></md-divider>
    ${active ? `<md-menu-item data-view-action="update" ${differs ? "" : "disabled"}>${differs ? badgedIcon("save") : '<md-icon slot="start">save</md-icon>'}<div slot="headline">Update “${escapeHtml(active.name)}”</div></md-menu-item>` : ""}
    <md-menu-item data-view-action="save" ${hasActiveFilters() ? "" : "disabled"}>${differs && hasActiveFilters() ? badgedIcon("bookmark_add") : '<md-icon slot="start">bookmark_add</md-icon>'}<div slot="headline">Save current filters as new view…</div></md-menu-item>`;
}

function applyView(view) {
  filterState.activeViewId = view ? view.id : null;
  filterState.current = { assignees: view ? [...view.assignees] : [], repos: view ? [...view.repos] : [] };
  filtersChanged();
}

function newViewId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function viewNameError(name, ignoredId) {
  if (!name) return "Enter a name.";
  const taken = filterState.views.some((view) => view.id !== ignoredId && view.name.toLowerCase() === name.toLowerCase());
  return taken ? "A view with this name already exists." : "";
}

function ensureViewDialog() {
  if (filterUi.nameDialog) return filterUi.nameDialog;
  const dialog = document.createElement("md-dialog");
  dialog.className = "view-dialog";
  dialog.innerHTML = `
    <div slot="headline"></div>
    <form id="view-name-form" slot="content" novalidate>
      <md-outlined-text-field class="view-name" label="View name" maxlength="${MAX_VIEW_NAME_LENGTH}" autocomplete="off" required></md-outlined-text-field>
    </form>
    <div slot="actions">
      <md-text-button class="view-cancel" type="button">Cancel</md-text-button>
      <md-filled-button class="view-confirm" type="submit" form="view-name-form">Save</md-filled-button>
    </div>`;
  document.body.append(dialog);
  const field = dialog.querySelector(".view-name");
  field.addEventListener("input", () => {
    field.error = false;
    field.errorText = "";
  });
  dialog.querySelector(".view-cancel").addEventListener("click", () => dialog.close());
  dialog.querySelector("form").addEventListener("submit", (event) => {
    event.preventDefault();
    const name = field.value.trim();
    const error = viewNameError(name, dialog.viewId);
    if (error) {
      field.error = true;
      field.errorText = error;
      field.focus();
      return;
    }
    const view = filterState.views.find((item) => item.id === dialog.viewId);
    if (view) {
      view.name = name;
      saveFilterState();
      syncFilterBar();
    } else {
      const created = { id: newViewId(), name, assignees: [...filterState.current.assignees], repos: [...filterState.current.repos] };
      filterState.views.push(created);
      filterState.activeViewId = created.id;
      filtersChanged();
    }
    dialog.close();
  });
  filterUi.nameDialog = dialog;
  return dialog;
}

function openViewNameDialog(view) {
  const dialog = ensureViewDialog();
  const field = dialog.querySelector(".view-name");
  dialog.viewId = view ? view.id : null;
  dialog.querySelector('[slot="headline"]').textContent = view ? "Rename view" : "Save view";
  dialog.querySelector(".view-confirm").textContent = view ? "Rename" : "Save";
  field.value = view ? view.name : "";
  field.error = false;
  field.errorText = "";
  dialog.show();
  dialog.addEventListener("opened", () => field.focus(), { once: true });
}

function ensureDeleteDialog() {
  if (filterUi.deleteDialog) return filterUi.deleteDialog;
  const dialog = document.createElement("md-dialog");
  dialog.className = "view-dialog";
  dialog.innerHTML = `
    <div slot="headline">Delete view?</div>
    <div slot="content"><p class="dialog-copy view-delete-copy"></p></div>
    <div slot="actions">
      <md-text-button class="view-cancel" type="button">Cancel</md-text-button>
      <md-filled-button class="view-delete" type="button">Delete</md-filled-button>
    </div>`;
  document.body.append(dialog);
  dialog.querySelector(".view-cancel").addEventListener("click", () => dialog.close());
  dialog.querySelector(".view-delete").addEventListener("click", () => {
    filterState.views = filterState.views.filter((view) => view.id !== dialog.viewId);
    if (filterState.activeViewId === dialog.viewId) filterState.activeViewId = null;
    filtersChanged();
    dialog.close();
  });
  filterUi.deleteDialog = dialog;
  return dialog;
}

function openViewDeleteDialog(view) {
  const dialog = ensureDeleteDialog();
  dialog.viewId = view.id;
  dialog.querySelector(".view-delete-copy").textContent = `“${view.name}” will be removed. The filters currently applied stay as they are.`;
  dialog.show();
}

function onViewMenuClick(event) {
  const target = event.target.closest("[data-view-action]");
  if (!target) return;
  const action = target.dataset.viewAction;
  const view = filterState.views.find((item) => item.id === target.dataset.viewId);
  if (action === "rename" || action === "delete") {
    // The icon buttons sit inside a menu item; keep the click from applying the view.
    event.stopPropagation();
    filterUi.viewMenu.close();
    if (view) (action === "rename" ? openViewNameDialog : openViewDeleteDialog)(view);
  } else if (action === "apply") {
    applyView(view);
  } else if (action === "default") {
    applyView(null);
  } else if (action === "update") {
    const current = activeView();
    if (!current) return;
    current.assignees = [...filterState.current.assignees];
    current.repos = [...filterState.current.repos];
    filtersChanged();
  } else if (action === "save") {
    openViewNameDialog(null);
  }
}

function initFilters() {
  const bar = document.querySelector("#filter-bar");
  if (!bar) return;
  bar.innerHTML = `
    <div class="view-button-wrap">
      <md-filled-tonal-button id="view-button" class="view-button" type="button" aria-haspopup="menu"><md-icon slot="icon">space_dashboard</md-icon>View</md-filled-tonal-button>
      <span class="view-badge" hidden aria-hidden="true"></span>
      <md-menu id="view-menu" class="view-menu" anchor="view-button" positioning="popover" quick aria-label="View"></md-menu>
    </div>
    <div class="filter-chip-wrap">
      <md-filter-chip id="assignee-chip" class="filter-chip" aria-haspopup="menu"><span class="chip-content"><span class="chip-label">Assignee</span><md-icon>arrow_drop_down</md-icon></span></md-filter-chip>
      <md-menu id="assignee-menu" class="filter-menu" anchor="assignee-chip" positioning="popover" quick aria-label="Assignee"></md-menu>
    </div>
    <div class="filter-chip-wrap">
      <md-filter-chip id="repo-chip" class="filter-chip" aria-haspopup="menu"><span class="chip-content"><span class="chip-label">Repository</span><md-icon>arrow_drop_down</md-icon></span></md-filter-chip>
      <md-menu id="repo-menu" class="filter-menu" anchor="repo-chip" positioning="popover" default-focus="none" quick aria-label="Repository">
        <div class="filter-search-row"><md-outlined-text-field class="filter-search" type="search" label="Search repositories" autocomplete="off"><md-icon slot="leading-icon">search</md-icon></md-outlined-text-field></div>
      </md-menu>
    </div>`;
  filterUi = {
    bar,
    viewButton: bar.querySelector("#view-button"),
    viewBadge: bar.querySelector(".view-badge"),
    viewMenu: bar.querySelector("#view-menu"),
    assigneeChip: bar.querySelector("#assignee-chip"),
    assigneeMenu: bar.querySelector("#assignee-menu"),
    repoChip: bar.querySelector("#repo-chip"),
    repoMenu: bar.querySelector("#repo-menu"),
    repoSearch: bar.querySelector(".filter-search"),
    options: { assignees: [], repos: [] },
    nameDialog: null,
    deleteDialog: null
  };

  filterUi.viewButton.addEventListener("click", () => {
    if (!filterUi.viewMenu.open) renderViewMenu();
    filterUi.viewMenu.open = !filterUi.viewMenu.open;
  });
  filterUi.viewMenu.addEventListener("click", onViewMenuClick, true);

  for (const [chip, menu] of [[filterUi.assigneeChip, filterUi.assigneeMenu], [filterUi.repoChip, filterUi.repoMenu]]) {
    // A filter chip toggles its own selected state (and flashes its check icon) on click. The capture
    // listener stops that: the state follows the selection instead, and the click only toggles the menu.
    chip.addEventListener("click", (event) => {
      event.stopPropagation();
      menu.open = !menu.open;
    }, true);
    menu.addEventListener("click", (event) => {
      const item = event.target.closest("md-menu-item[data-filter]");
      if (item) toggleFilterValue(item.dataset.filter, item.dataset.value);
    });
  }

  const search = filterUi.repoSearch;
  search.addEventListener("input", renderRepoItems);
  // The menu's typeahead would otherwise take the typed letters and move the focus to an item.
  const typeahead = (type) => () => search.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
  search.addEventListener("focusin", typeahead("deactivate-typeahead"));
  search.addEventListener("focusout", typeahead("activate-typeahead"));
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      filterUi.repoMenu.querySelector("md-menu-item")?.focus();
    }
    // Typing must not reach the menu's own keyboard handling; Escape and Tab still close it.
    if (event.key !== "Escape" && event.key !== "Tab") event.stopPropagation();
  });
  filterUi.repoMenu.addEventListener("opening", () => {
    search.value = "";
    renderRepoItems();
  });
  filterUi.repoMenu.addEventListener("opened", async () => {
    await search.updateComplete;
    search.focus();
  });
  refreshFilterOptions();
  syncFilterBar();
}
