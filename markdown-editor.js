// GitHub-style Markdown editor: Write/Preview tabs, formatting toolbar and keyboard helpers.
// Preview HTML comes from GitHub's Markdown API through the `renderPreview` callback.

const LIST_LINE = /^(\s*)(?:([-*+])|(\d+)([.)]))(?: (\[[ xX]\]))? (.*)$/;

const TOOLBAR_ACTIONS = [
  { name: "heading", icon: "title", label: "Heading" },
  { name: "bold", icon: "format_bold", label: "Bold (Ctrl+B)" },
  { name: "italic", icon: "format_italic", label: "Italic (Ctrl+I)" },
  { name: "quote", icon: "format_quote", label: "Quote" },
  { name: "code", icon: "code", label: "Code (Ctrl+E)" },
  { name: "link", icon: "link", label: "Link (Ctrl+K)" },
  { name: "bullets", icon: "format_list_bulleted", label: "Bulleted list" },
  { name: "numbers", icon: "format_list_numbered", label: "Numbered list" },
  { name: "tasks", icon: "checklist", label: "Task list" }
];

function lineStart(text, position) {
  return position === 0 ? 0 : text.lastIndexOf("\n", position - 1) + 1;
}

function lineEnd(text, position) {
  const end = text.indexOf("\n", position);
  return end === -1 ? text.length : end;
}

function createMarkdownEditor({ renderPreview, onSubmit }) {
  const element = document.createElement("div");
  element.className = "md-editor";
  element.innerHTML = `
    <div class="md-editor-bar">
      <md-tabs class="md-editor-tabs" aria-label="Description mode">
        <md-primary-tab class="md-tab-write">Write</md-primary-tab>
        <md-primary-tab class="md-tab-preview">Preview</md-primary-tab>
      </md-tabs>
      <div class="md-editor-toolbar" role="toolbar" aria-label="Formatting">
        ${TOOLBAR_ACTIONS.map((action) => `
          <md-icon-button data-action="${action.name}" aria-label="${action.label}" title="${action.label}"><md-icon>${action.icon}</md-icon></md-icon-button>`).join("")}
      </div>
    </div>
    <textarea class="md-editor-input" aria-label="Description" placeholder="Leave a description" spellcheck="true"></textarea>
    <div class="md-editor-preview markdown-body" hidden></div>
  `;
  const tabs = element.querySelector(".md-editor-tabs");
  const toolbar = element.querySelector(".md-editor-toolbar");
  const input = element.querySelector(".md-editor-input");
  const preview = element.querySelector(".md-editor-preview");
  let previewRequest = 0;
  let previewing = false;
  let disabled = false;

  function replaceRange(start, end, text, selectionStart, selectionEnd) {
    input.focus();
    input.setSelectionRange(start, end);
    // execCommand keeps the browser's native undo stack; setRangeText is the fallback.
    const done = text === "" ? document.execCommand("delete") : document.execCommand("insertText", false, text);
    if (!done) input.setRangeText(text, start, end, "end");
    input.setSelectionRange(selectionStart, selectionEnd);
  }

  function wrapSelection(before, after, placeholder) {
    const { selectionStart: start, selectionEnd: end, value } = input;
    const selected = value.slice(start, end);
    if (selected && value.slice(start - before.length, start) === before && value.slice(end, end + after.length) === after) {
      replaceRange(start - before.length, end + after.length, selected, start - before.length, end - before.length);
      return;
    }
    const content = selected || placeholder;
    replaceRange(start, end, `${before}${content}${after}`, start + before.length, start + before.length + content.length);
  }

  function toggleLinePrefix(detect, prefixFor) {
    const { selectionStart, selectionEnd, value } = input;
    const start = lineStart(value, selectionStart);
    const end = lineEnd(value, selectionEnd > selectionStart && value[selectionEnd - 1] === "\n" ? selectionEnd - 1 : selectionEnd);
    const lines = value.slice(start, end).split("\n");
    const filled = lines.filter((line) => line.trim());
    const remove = filled.length > 0 && filled.every((line) => detect.test(line));
    let counter = 0;
    const result = lines.map((line) => {
      if (remove) return line.replace(detect, "");
      if (!line.trim() && lines.length > 1) return line;
      counter += 1;
      return prefixFor(counter) + line;
    }).join("\n");
    const collapsed = selectionStart === selectionEnd;
    replaceRange(start, end, result, collapsed ? start + result.length : start, start + result.length);
  }

  function insertLink() {
    const { selectionStart: start, selectionEnd: end, value } = input;
    const selected = value.slice(start, end);
    if (selected) {
      const urlStart = start + selected.length + 3;
      replaceRange(start, end, `[${selected}](url)`, urlStart, urlStart + 3);
    } else {
      replaceRange(start, end, "[link text](url)", start + 1, start + 10);
    }
  }

  const actions = {
    heading: () => toggleLinePrefix(/^#{1,6} /, () => "### "),
    bold: () => wrapSelection("**", "**", "bold text"),
    italic: () => wrapSelection("_", "_", "italic text"),
    quote: () => toggleLinePrefix(/^> ?/, () => "> "),
    code: () => {
      const selected = input.value.slice(input.selectionStart, input.selectionEnd);
      if (selected.includes("\n")) wrapSelection("```\n", "\n```", "code");
      else wrapSelection("`", "`", "code");
    },
    link: insertLink,
    bullets: () => toggleLinePrefix(/^[-*+] (?!\[[ xX]\] )/, () => "- "),
    numbers: () => toggleLinePrefix(/^\d+[.)] /, (number) => `${number}. `),
    tasks: () => toggleLinePrefix(/^[-*+] \[[ xX]\] /, () => "- [ ] ")
  };

  toolbar.addEventListener("mousedown", (event) => event.preventDefault());
  toolbar.addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (button && !disabled && !previewing) actions[button.dataset.action]();
  });

  function continueList(event) {
    const { selectionStart: position, selectionEnd, value } = input;
    if (position !== selectionEnd) return false;
    const start = lineStart(value, position);
    const end = lineEnd(value, position);
    const match = LIST_LINE.exec(value.slice(start, end));
    if (!match || position < end - match[6].length) return false;
    event.preventDefault();
    if (match[6] === "") {
      replaceRange(start, end, "", start, start);
      return true;
    }
    const marker = match[2] || `${Number(match[3]) + 1}${match[4]}`;
    const next = `\n${match[1]}${marker} ${match[5] ? "[ ] " : ""}`;
    replaceRange(position, position, next, position + next.length, position + next.length);
    return true;
  }

  function indentListLine(event) {
    const { selectionStart, selectionEnd, value } = input;
    const start = lineStart(value, selectionStart);
    if (!LIST_LINE.test(value.slice(start, lineEnd(value, selectionStart)))) return;
    event.preventDefault();
    if (!event.shiftKey) {
      replaceRange(start, start, "  ", selectionStart + 2, selectionEnd + 2);
      return;
    }
    const removable = /^( {1,2}|\t)/.exec(value.slice(start))?.[0].length || 0;
    if (removable) {
      replaceRange(start, start + removable, "", Math.max(start, selectionStart - removable), Math.max(start, selectionEnd - removable));
    }
  }

  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && !event.altKey && !event.shiftKey) {
      const shortcuts = { b: "bold", i: "italic", k: "link", e: "code" };
      const action = shortcuts[event.key.toLowerCase()];
      if (action) {
        event.preventDefault();
        actions[action]();
        return;
      }
    }
    if (event.key === "Enter" && modifier) {
      event.preventDefault();
      onSubmit?.();
    } else if (event.key === "Enter" && !event.shiftKey && !event.altKey && !modifier) {
      continueList(event);
    } else if (event.key === "Tab" && !modifier && !event.altKey) {
      indentListLine(event);
    }
  });

  input.addEventListener("paste", (event) => {
    const { selectionStart: start, selectionEnd: end, value } = input;
    const pasted = (event.clipboardData?.getData("text/plain") || "").trim();
    const selected = value.slice(start, end);
    if (start === end || selected.includes("\n") || !/^https?:\/\/\S+$/.test(pasted)) return;
    event.preventDefault();
    const text = `[${selected}](${pasted})`;
    replaceRange(start, end, text, start + text.length, start + text.length);
  });

  async function showPreview() {
    const request = ++previewRequest;
    const text = input.value;
    if (!text.trim()) {
      preview.innerHTML = '<p class="md-editor-note">Nothing to preview.</p>';
      return;
    }
    preview.innerHTML = '<md-circular-progress indeterminate aria-label="Rendering preview"></md-circular-progress>';
    try {
      const html = await renderPreview(text);
      if (request !== previewRequest) return;
      preview.innerHTML = html;
      preview.querySelectorAll("a[href]").forEach((link) => {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      });
    } catch (error) {
      if (request !== previewRequest) return;
      const note = document.createElement("p");
      note.className = "md-editor-note md-editor-error";
      note.setAttribute("role", "alert");
      note.textContent = `Could not render the preview: ${error.message}`;
      preview.replaceChildren(note);
    }
  }

  function setPreviewing(value) {
    previewing = value;
    input.hidden = value;
    preview.hidden = !value;
    toolbar.classList.toggle("is-hidden", value);
    tabs.activeTabIndex = value ? 1 : 0;
    if (value) showPreview();
    else previewRequest += 1;
  }

  tabs.addEventListener("change", () => {
    const wantsPreview = tabs.activeTabIndex === 1;
    if (wantsPreview !== previewing) setPreviewing(wantsPreview);
  });

  return {
    element,
    get value() {
      return input.value;
    },
    set value(text) {
      input.value = text;
      if (previewing) showPreview();
    },
    set disabled(value) {
      disabled = value;
      input.disabled = value;
      toolbar.querySelectorAll("md-icon-button").forEach((button) => {
        button.disabled = value;
      });
    },
    showWrite() {
      if (previewing) setPreviewing(false);
      else tabs.activeTabIndex = 0;
    }
  };
}
