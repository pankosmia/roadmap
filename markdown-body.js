// Finishing touches for the Markdown that GitHub rendered (description and comments): wide tables scroll sideways inside
// their own box and code blocks get a copy button. Loaded before timeline.js and description.js.

const CODE_COPY_FEEDBACK_MS = 1500;

// GitHub wraps some tables in its own <markdown-accessiblity-table> element; the scroller goes around it.
function tableWrapTarget(table) {
  const parent = table.parentElement;
  return parent && parent.localName === "markdown-accessiblity-table" ? parent : table;
}

function copyButtonHtml() {
  return '<md-icon-button class="md-code-copy" type="button" aria-label="Copy code" title="Copy code"><md-icon>content_copy</md-icon></md-icon-button>';
}

function enhanceMarkdownBody(root) {
  // The copy buttons of GitHub's own page do nothing here.
  root.querySelectorAll("clipboard-copy, .zeroclipboard-container").forEach((element) => element.remove());
  root.querySelectorAll("table").forEach((table) => {
    const target = tableWrapTarget(table);
    if (target.parentElement?.classList.contains("md-table-scroll")) return;
    const scroller = document.createElement("div");
    scroller.className = "md-table-scroll";
    target.replaceWith(scroller);
    scroller.append(target);
  });
  root.querySelectorAll("pre").forEach((pre) => {
    if (pre.closest(".md-code-block")) return;
    const block = pre.parentElement?.classList.contains("highlight") ? pre.parentElement : null;
    const holder = block || document.createElement("div");
    holder.classList.add("md-code-block");
    if (!block) {
      pre.replaceWith(holder);
      holder.append(pre);
    }
    holder.insertAdjacentHTML("afterbegin", copyButtonHtml());
  });
}

async function onCodeCopyClick(event) {
  const button = event.target.closest(".md-code-copy");
  if (!button) return;
  const code = button.closest(".md-code-block")?.querySelector("pre");
  if (!code) return;
  const icon = button.querySelector("md-icon");
  try {
    await navigator.clipboard.writeText(code.textContent.replace(/\n$/, ""));
    icon.textContent = "check";
    button.title = "Copied";
    setTimeout(() => {
      icon.textContent = "content_copy";
      button.title = "Copy code";
    }, CODE_COPY_FEEDBACK_MS);
  } catch {
    showNotice("Could not copy the code. Your browser blocked access to the clipboard.", true);
  }
}

document.addEventListener("click", onCodeCopyClick);
