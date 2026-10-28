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
- change Version, Flow and Blocked (chips in the Workflow area; changing Version
  moves the card, and Flow defaults to `Flow : No Spec` when leaving Unassigned
  without one);
- toggle the Epic and WIP meta labels, and pick Type (exclusive), Stack
  (multiple choices) and Priority (optional, Tweak / Urgent / Security, click
  again to clear) in single-row connected button groups;
- add or remove assignees from a GitHub-style popover (search, checkmarks,
  selected users first);
- see the linked pull requests and branches (Development, read-only);
- manage Parent, Sub-issues, Blocked by and Blocking relationships, searching
  issues across the whole organization.

When creating an issue, Type and Stack are mandatory (marked with `*`, no
default). Pressing **Create** with a missing title, Type or Stack turns the
field red and focuses the first one. Existing issues without these labels are
not blocked. Relationships chosen for a new issue are applied right after it is
created. The Settings column is 440px wide and sits next to the description from
a 940px panel width.

Dropdown options are read from each repository's existing labels. A warning icon
appears when an expected label is missing from the repository. The **+ Add**
button on the main page creates an issue (default repository: `roadmap`) in
Unassigned and opens it in the side panel. Cards show their labels in their
GitHub colors, without the text before the ":" (for example "Spec'd" for
"Flow : Spec'd"). Moving an issue replaces all of its existing `Version : ...`
labels with the selected version label; other labels are preserved.

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
