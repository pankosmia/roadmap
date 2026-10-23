# Iffy

Iffy is a GitHub Pages issue board for planning work across public repositories
in the Pankosmia organization. Issues are grouped into **Unassigned**, **Backlog**,
**Next**, and **Current** according to their `Version : ...` label. Issues without
a Version label appear under **Unassigned**.

The board is read-only until a user connects a GitHub personal access token with
Issues read and write access to the repositories they want to update. The token
is kept in page memory only and is never saved to browser storage. Moving an
issue replaces all of its existing `Version : ...` labels with the selected
version label; other labels are preserved.

To publish Iffy, enable GitHub Pages in the repository settings and select
**Deploy from a branch**, `main`, and `/(root)` as the source.
