# Iffy

https://pankosmia.github.io/roadmap/

Iffy is a GitHub Pages issue board for planning open issues across public repositories
in the Pankosmia organization. Issues are grouped into **Unassigned**, **Backlog**,
**Next**, and **Current** according to their `Version : ...` label. Issues without
a Version label appear under **Unassigned**.

The board is read-only until a user connects a GitHub personal access token with
Issues read and write access to the repositories they want to update. The token
is kept for the browser session only, unless **Remember me** is ticked in the
connect dialog, in which case it is stored in the browser's local storage until
the user disconnects.

Clicking an issue opens it in a right-anchored side panel (it does not open
GitHub). Once connected, the panel lets you:

- read the description as on GitHub and edit the title and description on demand
  (pencil button, then Save or Cancel);
- add or remove assignees from a GitHub-style popover (search, checkmarks,
  selected users first), opened by the Assignees heading (shown above Workflow);
- change Version, Flow and Blocked (one menu chip each in the Workflow area,
  on one row that wraps to a second line when narrow; changing Version moves
  the card, and Flow defaults to `Flow : No Spec` when leaving Unassigned
  without one);
- toggle the Epic and WIP meta labels, and pick Type (exclusive: Feature, Bug,
  Tech Debt), Stack (multiple choices: Client, Server, Data, Build,
  Documentation) and Priority (optional, Tweak / Urgent / Security, click
  again to clear) in single-row connected button groups;
- see the linked pull requests and branches (Development, read-only). Pull
  request icons use the issue colors: green open, purple merged, gray draft,
  red closed without merging. Cards and the Archives dialog show one icon (merged,
  then open, draft, closed) with the number of linked pull requests; clicking it
  lists each pull request with its own icon and a link (needs a connected token);
- manage Parent, Sub-issues, Blocked by and Blocking relationships, searching
  issues across the whole organization, from the Relationships heading.

Closing an issue (Close button, Flow menu or moving it to Done) shows a snackbar
with **Undo**, which reopens it with its previous labels (and deletes the
"Duplicate of …" comment when it was closed as duplicate). When the issue has open
subissues (at any depth), a dialog lists them first: **Close all** closes them with
the issue, **Close #N only** leaves them open, and Cancel closes nothing. Undo then
reopens the subissues closed with it. Reopening an issue (Reopen button, leaving
the Done flow) offers the same choice for its subissues closed within five minutes
of it. On Next and Current
pages a closed issue gets the `Flow : Done` label and stays in the Done column
(moving a card into Done closes it, moving a closed card out reopens it; the column
reminds it at the bottom). The main page shows open issues only. Reopening with the
panel button keeps `Flow : Done`. An issue closed with a Backlog or Unassigned
Version goes straight to the archives, and the snackbar says so.

The **Archives** button (main and version pages) opens the **Archived issues (N)**
dialog. An issue is archived 30 days after it was closed, or, when it is still open
in the Done flow of Next or Current, 30 days after its last update; an issue closed
with a Backlog or Unassigned Version is archived at once. A subissue is archived only
when its parent is archived: while the parent is open or still on the board, a closed
subissue stays under it, whatever its own Version. (N may count such subissues until
they have been loaded.) Archived issues are loaded
from GitHub 100 at a time, with a **Load 100 more** button at the end of the list
(GitHub search returns at most 1,000 issues per query).

**Live updates** (`live-sync.js`): the board follows what teammates change on
GitHub without a manual **Refresh**. While the tab is visible, one search request per
minute (every two minutes without a token) asks for the issues updated since the last
check and merges them by issue id; the check also runs when the tab becomes visible or
regains focus. A full reconcile every 10 minutes also catches deleted or transferred
issues and changes that do not bump an issue's update time. Changed cards flash briefly
and a snackbar says how many issues were updated. Updates wait while a card is being
dragged, a field on the board is being typed in or a pull request popover is open. An
open panel follows the issue; its title and description are only replaced when nothing
was typed in them, otherwise a warning is shown. On a rate limit or an error the checks
slow down (the tooltip of **Refresh** says so), and **Refresh** still reloads everything.
Label and assignee changes are rebased on the issue as GitHub has it just before saving,
so a teammate's concurrent change to the same lists is kept.

Type and Stack are always marked with `*`, and their last selected choice cannot
be deselected. Existing issues without these labels are left as they are. When
creating an issue, they are mandatory (no default): pressing **Create** with a
missing title, Type or Stack turns the field red and focuses the first one, and
the message goes away once everything is filled in. The Repository field is a
searchable popover like Assignees, with the search box focused on open.
Relationships chosen for a
new issue are applied right after it is created.

On an existing issue, labels, assignees and relationships change instantly on
screen and are saved in the background: label and assignee changes wait 600 ms
without another click, so quick clicks are sent as one request. A failed save
restores what GitHub has and shows an error. Closing the panel sends pending
changes at once. The title and description still use **Save**.

**Timeline** (`timeline.js`): below the description, the panel shows the life of the
issue as on GitHub, from the REST timeline endpoint (readable without a token). It
lists the opening, comments (rendered Markdown, author badge, "edited" marker,
collapsed minimized comments), reviews, commits, and events such as labels,
assignees, renames, state changes, milestones, references, cross-references,
parent and sub-issues, blocking relationships and pull request activity. Label and
assignee events by the same person within 10 minutes become one row, and a run of
Project board events is a single "Dashboard workflow actions were performed (N
changes)" row, collapsed by default with a chevron. A run of 7 or more consecutive
activity rows folds into "N activity items hidden"; comments, closed/reopened
events and the 3 most recent activity rows are never folded, and an expanded fold
stays open until the panel closes. **Show all activity** disables folding, and the
**All / Comments / Activity** chips filter the list. The newest 100 items load
first (until 20 items are shown), and **Load older items** fetches the rest.
The arrow button switches between oldest first (composer at the end) and newest
first (composer on top); the choice is stored in `localStorage`
(`roadmap-timeline-order`) and applies to every panel and to the other tabs.
With a token you can write comments in a Markdown editor (**Close with comment** /
**Reopen with comment** post the comment, then change the state), quote or copy the
link of a comment, add and remove reactions, and edit or delete your own comments
(repository admins can delete any comment). A draft comment or an open comment edit
counts as unsaved changes when the panel closes. The timeline follows the board's
live updates (see above) and refreshes after the panel's own saves; without a token
it is read-only.

**Mentions** (`mentions.js`, `markdown-editor.js`): typing `@` in a Markdown editor
(description, new comment, comment edit) opens a list of up to 5 people at the caret,
as on GitHub. The issue's author, latest commenters and assignees come first, then
the other assignable people of the repository, then the people GitHub reports as
mentionable in it (GraphQL `mentionableUsers`, searched by login or name while you
type, cached for the session). ↑ / ↓ move, Enter or Tab insert `@login `, Esc closes
the list (and does not close the panel), and clicking a person works too. The list
only opens after whitespace or a `(`, so an email address does not trigger it.

**Description** (`description.js`): an existing issue opens in read mode, like a GitHub
issue. The title is a heading and the opening message is a card with its author, date,
an "edited" marker (needs a token, from GraphQL `lastEditedAt`) and the Markdown rendered
by GitHub. Task-list checkboxes can be ticked: the board re-reads the description, checks
nobody changed it, then saves at once (and restores the box with an error if GitHub
refuses). A box is disabled when the Markdown and the rendered HTML do not line up, or
without a token. The pencil button switches the title and description to the editors
(**Save** / **Cancel**; Cancel asks before discarding changes). A new issue still opens
in edit mode. The rendered body is kept out of the board's issue cache.

Menus open and close without animation.

The Settings column is 440px wide and sits next to the description from a 940px
panel width.

Dropdown options are read from each repository's existing labels. A warning icon
appears when an expected label is missing from the repository. The **+ Add**
button (main and version pages) creates an issue (default repository: `roadmap`) in
Unassigned and opens it in the side panel. Cards show their labels in their
GitHub colors, without the text before the ":" (for example "Spec'd" for
"Flow : Spec'd"). Chips follow a fixed order: Type, Stack, Priority, then the other
labels (alphabetical). `Meta` labels (Epic, WIP) appear at the top right of the card,
and a `Blocked : …` label is shown as a red stop icon before the title (its reason is in
the tooltip). Cards are moved by dragging them between columns. Repository names are shown without the `pankosmia/` prefix. Below a divider,
a card shows the last update time as on GitHub ("Updated 3 days ago", then an
absolute date after 30 days) on the left, and on the right (from right to left) its
assignees, its comment count (hidden when 0) and the linked pull request icon. Columns on every page are sorted by last update, most
recent first. The **Subissues (done/total)** button, with a thin progress bar along its bottom edge, expands the
subissues in the manual order stored on GitHub (loaded in the background after the board, when signed in, so a list opens in its final order). Each
row shows its status icon (closed ones are dimmed), reference and assignees, and
nested subissues appear indented under their parent; clicking a row opens it in the
side panel (closed subissues too; they stay off the board). With a token, the drag handle (or the up and down arrow keys when it is
focused) reorders siblings and saves the new priority on GitHub, and
**Add subissue** opens the Create issue panel with the parent already set (and its
repository selected); the new issue is linked under the parent when it is created.
Moving an issue replaces all of its existing `Version : ...`
labels with the selected version label; other labels are preserved.

Drag and drop also changes the hierarchy. Drag a card, or a subissue by its row or its
handle, over a subissue row: the target shows at once. The middle of a row means
"move under this issue" (solid outline), the top or bottom 40% means "insert at this
position" (a thick line with a soft band showing the target size), and red means not
allowed (itself, its own subissue, or deeper than 8 levels). The small gaps between
rows snap to the nearest row, so the target does not flicker. Over a whole card, hold
for a moment (or press Shift) to arm it; a fill sweeps across the card meanwhile, and
a drop before that just moves the card to the column. A tooltip below the pointer says
what the drop does; the dragged issue is shown as a small label. While reordering
siblings, the dragged row is dimmed, the same line and band show where it will land
and the tooltip says "Put #N here"; the order is saved on drop. A subissue dropped on its own parent card stays where it
is. Dropping a subissue on a
column removes it from its parent and moves it there (on a version page it also gets
that page's Version label). Every hierarchy change shows an **Undo** snackbar.

A one-line footer at the bottom of every page shows the issue count and the
click/drag hint. Below the search bar (centered; its container spans the width of
the columns), every page has a **View** button (tonal, layout icon) and two filter chips,
**Assignee** and **Repository** (`filters.js`). Both chips are multi-select menus
listing the assignees (plus **Unassigned**) and repositories of the loaded open
issues, with their issue counts; the Repository menu starts with a search field
that is focused on open. A card is shown when it matches the selection of
each chip (any selected value within a chip). A parent issue stays visible when
one of its sub-issues matches, and the board summary reads "N of M issues" while
filters are on. The search text is not part of the filters or of the views.
The **View** menu offers the default (unfiltered) view, the saved views (apply,
rename, delete), **Update** for the active view and **Save current filters as new
view…** (named, unique names); **Update** and **Save** carry a dot while there is
a pending difference. The View button shows a colored dot when the chips
differ from the view that was active before they were touched: the default view,
or the saved view that was applied. Filters and views are stored in the browser's
local storage (`roadmap-filters`) and shared by all pages.

The toolbar buttons read **Add**, **Notifications**, **Pull requests** (a tonal
button) and **Archives**. The **Pull requests** button opens a dialog listing every open pull request of the organization (`open-pulls.js`,
one paginated GraphQL search, loaded with the board and cached for 5 minutes,
**Refresh** to reload; needs a connected token). Each row shows the state icon,
title, repository, number, author and age, and links to the pull request. Pull
requests linked to an issue in their Development area have a colored edge and a
chip linking to each issue; orphan pull requests have a "No issue" chip.

Pull requests can raise an alert, shown as a red chip on the row, an **Alerts
only** filter in the dialog, and a red count badge on the button (hidden at 0).
Hours are calendar hours (thresholds are constants in `open-pulls.js`):

- **Draft**: a draft for 30 days or more, counted from its last "convert to draft"
  event, or from its creation;
- **Waiting for review**: a non-draft pull request with a pending review request
  (or no review at all) for 48 hours or more, counted from the last review request or
  "ready for review" event, or from its creation.

The **Notifications** button (`notifications.js`, main and version pages) opens a
menu with the GitHub notifications of the connected account, limited to the
organization, like GitHub's inbox: a thread is **unread** (tinted row with a dot,
counted in the red badge on the button, capped at 99+) until it is opened or marked
as read with its envelope button; it then stays listed, no longer highlighted; the
**check** button marks it as **done** and it goes away. Done is sent to GitHub
after the 8 second **Undo** delay (or when the page is left), since GitHub's API
cannot undo it. **All** / **Unread** button group (All by default, the choice is remembered in
local storage as `roadmap-notifications-tab`), the refresh button (its icon spins
while loading), **Mark all as read** (sent per
repository, so other organizations are untouched) and **Refresh** are in the menu.
Clicking a row opens the issue in the side panel when it is loaded on the board,
and the thread on GitHub otherwise. The list is read with `GET /notifications?all=true`
(up to 300 threads), refreshed with the live sync (about every minute) and cached
for the browser session. GitHub only serves notifications to a **classic token with
the `notifications` scope** (plus `public_repo` to edit issues); with a fine-grained
token the menu explains this. GitHub's API has no "mark as unread".

On cards and in the Archives dialog, the linked pull request count is a filled badge
in the color of the pull request state.

The UI follows the Material 3 design system. Components come from
[`@material/web`](https://github.com/material-components/material-web), loaded
from a CDN through the import map in each HTML page (`m3.js` loads the single
`all.js` entry, because a CDN bundles each component file separately and importing
several of them registers shared elements twice), so there is no build step and the page needs internet access
for the components and for the Roboto and Material Symbols fonts. Color roles,
shapes, elevation and type scale are defined in `m3-theme.css` (light and dark
schemes, generated from the seed color `#441650`), and `styles.css` holds the
layout.

To publish Iffy, enable GitHub Pages in the repository settings and select
**Deploy from a branch**, `main`, and `/(root)` as the source.
