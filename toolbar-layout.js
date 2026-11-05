// Toolbar layout: the actions and the filters stay on one row each. They sit side by side while they fit; when they do
// not, the actions go above the filters (the is-stacked class), and a row that is still too narrow scrolls sideways.
// Loaded before app.js; the filters are added to the bar later by filters.js, which is why the bar is observed.

// Fades the edges of a sideways scrolling element where more content hides, and lets the mouse wheel scroll it.
function watchSidewaysScroll(element) {
  const update = () => {
    const hidden = element.scrollWidth - element.clientWidth;
    element.classList.toggle("can-scroll-start", element.scrollLeft > 1);
    element.classList.toggle("can-scroll-end", hidden > 1 && element.scrollLeft < hidden - 1);
  };
  element.addEventListener("scroll", update, { passive: true });
  element.addEventListener(
    "wheel",
    (event) => {
      if (element.scrollWidth <= element.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      element.scrollLeft += event.deltaY;
    },
    { passive: false }
  );
  new ResizeObserver(update).observe(element);
  return update;
}

function contentWidth(element) {
  const children = [...element.children];
  const gap = parseFloat(getComputedStyle(element).columnGap) || 0;
  return children.reduce((total, child) => total + child.offsetWidth, 0) + gap * Math.max(0, children.length - 1);
}

function setupToolbarLayout() {
  const row = document.querySelector(".toolbar-row");
  const actions = row?.querySelector(".heading-actions");
  const bar = row?.querySelector(".filter-bar");
  if (!bar) return;

  const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
  const layout = () => {
    const needed = contentWidth(actions) + contentWidth(bar) + gap;
    row.classList.toggle("is-stacked", needed > row.clientWidth);
  };

  const watched = [actions, bar].map(watchSidewaysScroll);
  const observer = new ResizeObserver(layout);
  observer.observe(row);
  // A child is observed too: its width changes with its label, and the width of the bar itself does not say how wide its content is.
  const observeChildren = () => {
    for (const element of [...actions.children, ...bar.children]) observer.observe(element);
    watched.forEach((update) => update());
    layout();
  };
  new MutationObserver(observeChildren).observe(bar, { childList: true });
  observeChildren();
}

setupToolbarLayout();
