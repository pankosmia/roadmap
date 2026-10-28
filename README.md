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

- edit the title and description (with a Save button);
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
  red closed without merging. Cards and the Done dialog show one icon (merged,
  then open, draft, closed) with the number of linked pull requests; clicking it
  lists each pull request with its own icon and a link (needs a connected token);
- manage Parent, Sub-issues, Blocked by and Blocking relationships, searching
  issues across the whole organization, from the Relationships heading.

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

Menus open and close without animation.

The Settings column is 440px wide and sits next to the description from a 940px
panel width.

Dropdown options are read from each repository's existing labels. A warning icon
appears when an expected label is missing from the repository. The **+ Add**
button on the main page creates an issue (default repository: `roadmap`) in
Unassigned and opens it in the side panel. Cards show their labels in their
GitHub colors, without the text before the ":" (for example "Spec'd" for
"Flow : Spec'd"). Moving an issue replaces all of its existing `Version : ...`
labels with the selected version label; other labels are preserved.

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

The **Pull requests** button, to the right of **Done** (main and version pages),
opens a dialog listing every open pull request of the organization (`open-pulls.js`,
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

On cards and in the Done dialog, the linked pull request count is a filled badge
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
