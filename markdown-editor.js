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
  { name: "image", icon: "image", label: "Add an image" },
  { name: "bullets", icon: "format_list_bulleted", label: "Bulleted list" },
  { name: "numbers", icon: "format_list_numbered", label: "Numbered list" },
  { name: "tasks", icon: "checklist", label: "Task list" }
];

// As GitHub does: an <img> tag with its size when it is known (the width and height can then be edited in the text,
// and GitHub renders them in the preview and in the posted message), a plain Markdown image otherwise.
function imageMarkup({ url, alt, width = 0, height = 0 }) {
  if (width > 0 && height > 0) {
    const text = alt.replace(/[&<>"\n]/g, " ").trim() || "image";
    return `<img width="${width}" height="${height}" alt="${text}" src="${url}" />`;
  }
  return `![${alt.replace(/[[\]\n]/g, " ").trim() || "image"}](${url})`;
}

function lineStart(text, position) {
  return position === 0 ? 0 : text.lastIndexOf("\n", position - 1) + 1;
}

function lineEnd(text, position) {
  const end = text.indexOf("\n", position);
  return end === -1 ? text.length : end;
}

const MENTION_LIMIT = 5;
const MENTION_REMOTE_DELAY = 250;
const MENTION_NAME = /^[\w-]{0,39}$/;
const MIRRORED_STYLES = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "textTransform", "wordSpacing", "tabSize",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"
];
let mentionIds = 0;

// Viewport position of the character at `index` in a textarea, measured on a hidden copy of its text.
function caretPoint(textarea, index) {
  const style = getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const name of MIRRORED_STYLES) mirror.style[name] = style[name];
  Object.assign(mirror.style, {
    position: "absolute",
    visibility: "hidden",
    top: "0",
    left: "-9999px",
    boxSizing: "border-box",
    width: `${textarea.clientWidth}px`,
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word"
  });
  mirror.textContent = textarea.value.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  const rect = textarea.getBoundingClientRect();
  const point = {
    left: rect.left + textarea.clientLeft + marker.offsetLeft - textarea.scrollLeft,
    top: rect.top + textarea.clientTop + marker.offsetTop - textarea.scrollTop,
    height: marker.offsetHeight
  };
  mirror.remove();
  return point;
}

// Scroll positions of the areas around `element`; the textarea shrinks for a moment when it is measured, which would
// otherwise throw them back up.
function scrollPositions(element) {
  const positions = [];
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (node.scrollTop > 0) positions.push([node, node.scrollTop]);
  }
  return positions;
}

// `mentions` is optional and turns on GitHub-style "@" suggestions: { local(query), remote(query) }.
// local returns the people known at once, remote a promise of more (or null).
// `uploadImage` is optional and turns on image upload (paste, drop, toolbar button): file => promise of { url, alt, width, height }.
function createMarkdownEditor({ renderPreview, onSubmit, onInput = null, mentions = null, uploadImage = null, label = "Description", placeholder = "Leave a description" }) {
  const element = document.createElement("div");
  element.className = "md-editor";
  element.innerHTML = `
    <div class="md-editor-bar">
      <md-tabs class="md-editor-tabs">
        <md-primary-tab class="md-tab-write">Write</md-primary-tab>
        <md-primary-tab class="md-tab-preview">Preview</md-primary-tab>
      </md-tabs>
      <div class="md-editor-toolbar" role="toolbar" aria-label="Formatting">
        ${TOOLBAR_ACTIONS.filter((action) => action.name !== "image" || uploadImage).map((action) => `
          <md-icon-button data-action="${action.name}" aria-label="${action.label}" title="${action.label}"><md-icon>${action.icon}</md-icon></md-icon-button>`).join("")}
      </div>
    </div>
    <textarea class="md-editor-input" spellcheck="true"></textarea>
    <div class="md-editor-preview markdown-body" hidden></div>
    <p class="md-editor-status" role="status" hidden></p>
  `;
  const tabs = element.querySelector(".md-editor-tabs");
  const toolbar = element.querySelector(".md-editor-toolbar");
  const input = element.querySelector(".md-editor-input");
  const preview = element.querySelector(".md-editor-preview");
  const status = element.querySelector(".md-editor-status");
  input.setAttribute("aria-label", label);
  input.placeholder = placeholder;
  tabs.setAttribute("aria-label", `${label} mode`);
  let previewRequest = 0;
  let previewing = false;
  let disabled = false;
  let pendingUploads = 0;
  let filePicker = null;

  const mention = { open: false, start: 0, query: "", local: [], remote: [], items: [], active: 0, timer: 0, request: 0 };
  let mentionList = null;

  // The textarea is as tall as its text; the CSS minimum and maximum (and the textarea's own scrolling) do the rest.
  function fitHeight() {
    if (input.hidden || input.clientWidth === 0) return;
    const positions = scrollPositions(input);
    // Without this the textarea would be measured at the height it was stretched to, and never shrink.
    input.style.flex = "none";
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
    input.style.flex = "";
    for (const [node, top] of positions) node.scrollTop = top;
  }

  function replaceRange(start, end, text, selectionStart, selectionEnd) {
    input.focus();
    input.setSelectionRange(start, end);
    // execCommand keeps the browser's native undo stack; setRangeText is the fallback.
    const done = text === "" ? document.execCommand("delete") : document.execCommand("insertText", false, text);
    if (!done) {
      input.setRangeText(text, start, end, "end");
      fitHeight();
    }
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
    image: () => filePicker?.click(),
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

  function mentionContext() {
    const caret = input.selectionStart;
    if (!mentions || disabled || previewing || caret === 0 || caret !== input.selectionEnd) return null;
    const start = input.value.lastIndexOf("@", caret - 1);
    if (start === -1) return null;
    const query = input.value.slice(start + 1, caret);
    const before = input.value[start - 1];
    if (!MENTION_NAME.test(query) || (before !== undefined && !/[\s(]/.test(before))) return null;
    return { start, query };
  }

  function createMentionList() {
    mentionList = document.createElement("div");
    mentionList.className = "md-mention-menu";
    mentionList.id = `md-mention-${++mentionIds}`;
    mentionList.setAttribute("popover", "manual");
    // Keeps the focus in the textarea while the list is clicked.
    mentionList.addEventListener("mousedown", (event) => event.preventDefault());
    mentionList.addEventListener("click", (event) => {
      const option = event.target.closest("[data-index]");
      if (option) chooseMention(mention.items[Number(option.dataset.index)]);
    });
    mentionList.addEventListener("pointermove", (event) => {
      const option = event.target.closest("[data-index]");
      if (option && Number(option.dataset.index) !== mention.active) {
        mention.active = Number(option.dataset.index);
        paintActiveMention();
      }
    });
    element.append(mentionList);
  }

  function paintActiveMention() {
    mentionList.querySelectorAll("[data-index]").forEach((option) => {
      const active = Number(option.dataset.index) === mention.active;
      option.classList.toggle("is-active", active);
      option.setAttribute("aria-selected", String(active));
      if (active) input.setAttribute("aria-activedescendant", option.id);
    });
  }

  function placeMentionList() {
    const point = caretPoint(input, mention.start);
    const width = mentionList.offsetWidth;
    const height = mentionList.offsetHeight;
    const left = Math.max(8, Math.min(point.left, window.innerWidth - width - 8));
    const below = point.top + point.height + 4;
    const top = below + height > window.innerHeight - 8 && point.top - height - 4 > 8 ? point.top - height - 4 : below;
    mentionList.style.left = `${left}px`;
    mentionList.style.top = `${top}px`;
  }

  function renderMentions() {
    const seen = new Set();
    mention.items = [...mention.local, ...mention.remote]
      .filter((user) => !seen.has(user.login.toLowerCase()) && seen.add(user.login.toLowerCase()))
      .slice(0, MENTION_LIMIT);
    if (mention.items.length === 0) {
      closeMentions();
      return;
    }
    const keep = mention.items.findIndex((user) => user.login === mention.activeLogin);
    mention.active = keep === -1 ? 0 : keep;
    if (!mentionList) createMentionList();
    mentionList.replaceChildren();
    const list = document.createElement("div");
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "People to mention");
    mention.items.forEach((user, index) => {
      const option = document.createElement("div");
      option.className = "md-mention-option";
      option.id = `${mentionList.id}-${index}`;
      option.dataset.index = String(index);
      option.setAttribute("role", "option");
      if (user.avatar_url) {
        const avatar = document.createElement("img");
        avatar.className = "md-mention-avatar";
        avatar.src = user.avatar_url;
        avatar.alt = "";
        avatar.width = 24;
        avatar.height = 24;
        option.append(avatar);
      }
      const login = document.createElement("span");
      login.className = "md-mention-login";
      login.textContent = user.login;
      option.append(login);
      if (user.name) {
        const name = document.createElement("span");
        name.className = "md-mention-name";
        name.textContent = user.name;
        option.append(name);
      }
      list.append(option);
    });
    mentionList.append(list);
    if (!mention.open) {
      mention.open = true;
      input.setAttribute("aria-controls", mentionList.id);
      window.addEventListener("scroll", onMentionScroll, true);
      window.addEventListener("resize", closeMentions);
    }
    if (!mentionList.matches(":popover-open")) mentionList.showPopover();
    placeMentionList();
    paintActiveMention();
  }

  // The textarea scrolls by itself while typing, so only the other scrolls dismiss the list.
  function onMentionScroll(event) {
    if (event.target === input) placeMentionList();
    else closeMentions();
  }

  function closeMentions() {
    clearTimeout(mention.timer);
    mention.request += 1;
    if (!mention.open) return;
    mention.open = false;
    mention.local = [];
    mention.remote = [];
    mention.items = [];
    mentionList.hidePopover();
    input.removeAttribute("aria-controls");
    input.removeAttribute("aria-activedescendant");
    window.removeEventListener("scroll", onMentionScroll, true);
    window.removeEventListener("resize", closeMentions);
  }

  function updateMentions() {
    const context = mentionContext();
    if (!context) {
      closeMentions();
      return;
    }
    if (mention.open && context.start === mention.start && context.query === mention.query) return;
    mention.activeLogin = mention.items[mention.active]?.login;
    // The list stays hidden while nothing matches, so it does not flash empty before remote people arrive.
    const changed = context.start !== mention.start || context.query !== mention.query;
    mention.start = context.start;
    mention.query = context.query;
    if (changed) mention.remote = [];
    mention.local = mentions.local?.(context.query) || [];
    renderMentions();
    clearTimeout(mention.timer);
    const request = ++mention.request;
    mention.timer = setTimeout(async () => {
      let found = null;
      try {
        found = await mentions.remote?.(context.query);
      } catch {
        found = null;
      }
      if (!found || request !== mention.request) return;
      mention.remote = found;
      renderMentions();
    }, MENTION_REMOTE_DELAY);
  }

  function chooseMention(user) {
    if (!user) return;
    const { start } = mention;
    const end = input.selectionStart;
    closeMentions();
    const text = `@${user.login} `;
    replaceRange(start, end, text, start + text.length, start + text.length);
  }

  // Returns true when the key was used by the open suggestion list.
  function handleMentionKey(event) {
    if (!mention.open) return false;
    const count = mention.items.length;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMentions();
      return true;
    }
    if (count === 0 || event.altKey || event.ctrlKey || event.metaKey) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      mention.active = (mention.active + (event.key === "ArrowDown" ? 1 : count - 1)) % count;
      paintActiveMention();
      return true;
    }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
      event.preventDefault();
      chooseMention(mention.items[mention.active]);
      return true;
    }
    return false;
  }

  input.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    if (handleMentionKey(event)) return;
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

  function showStatus(message, isError = false) {
    status.hidden = !message;
    status.textContent = message;
    status.classList.toggle("md-editor-error", isError);
    status.setAttribute("role", isError ? "alert" : "status");
  }

  // The text is swapped without moving the caret, and an upload whose placeholder was deleted is dropped.
  function replacePlaceholder(placeholder, replacement) {
    const index = input.value.indexOf(placeholder);
    if (index === -1) return;
    input.setRangeText(replacement, index, index + placeholder.length, "preserve");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function addImage(file) {
    let placeholder = `![Uploading ${file.name || "image"}…]()`;
    for (let copy = 2; input.value.includes(placeholder); copy += 1) placeholder = `![Uploading ${file.name || "image"} (${copy})…]()`;
    const { selectionStart: start, selectionEnd: end, value } = input;
    const before = start > 0 && value[start - 1] !== "\n" ? "\n" : "";
    const text = `${before}${placeholder}\n`;
    replaceRange(start, end, text, start + text.length, start + text.length);
    pendingUploads += 1;
    showStatus(`Uploading ${file.name || "image"}…`);
    try {
      replacePlaceholder(placeholder, imageMarkup(await uploadImage(file)));
      pendingUploads -= 1;
      if (pendingUploads === 0) showStatus("");
    } catch (error) {
      replacePlaceholder(`${placeholder}\n`, "");
      pendingUploads -= 1;
      showStatus(error.message, true);
    }
  }

  function imageFiles(transfer) {
    return [...(transfer?.files || [])].filter((file) => file.type.startsWith("image/"));
  }

  if (uploadImage) {
    filePicker = document.createElement("input");
    filePicker.type = "file";
    filePicker.accept = ASSET_ACCEPT;
    filePicker.multiple = true;
    filePicker.hidden = true;
    filePicker.addEventListener("change", () => {
      const files = [...filePicker.files];
      filePicker.value = "";
      input.focus();
      files.forEach(addImage);
    });
    element.append(filePicker);

    input.addEventListener("dragover", (event) => {
      if (disabled || !event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      element.classList.add("is-dropping");
    });
    for (const name of ["dragleave", "drop"]) input.addEventListener(name, () => element.classList.remove("is-dropping"));
    input.addEventListener("drop", (event) => {
      const files = imageFiles(event.dataTransfer);
      if (disabled || !files.length) return;
      event.preventDefault();
      input.focus();
      files.forEach(addImage);
    });
  }

  input.addEventListener("paste", (event) => {
    const files = imageFiles(event.clipboardData);
    // Cells copied from a spreadsheet come as text and as a picture: the text wins.
    if (uploadImage && !disabled && files.length && !event.clipboardData.getData("text/plain")) {
      event.preventDefault();
      files.forEach(addImage);
      return;
    }
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
    closeMentions();
    // The Preview is as tall as the text area it replaces, so that switching tabs does not move the page.
    if (value && input.offsetHeight > 0) preview.style.minHeight = `${input.offsetHeight}px`;
    input.hidden = value;
    preview.hidden = !value;
    toolbar.classList.toggle("is-hidden", value);
    tabs.activeTabIndex = value ? 1 : 0;
    if (value) showPreview();
    else previewRequest += 1;
  }

  input.addEventListener("input", () => {
    fitHeight();
    updateMentions();
    onInput?.();
  });
  // The width changes the line wrapping, and a textarea that was hidden (closed panel, Preview tab) has no size yet.
  let fittedWidth = 0;
  new ResizeObserver(() => {
    if (input.clientWidth === fittedWidth) return;
    fittedWidth = input.clientWidth;
    fitHeight();
  }).observe(input);
  if (mentions) {
    input.addEventListener("click", updateMentions);
    input.addEventListener("keyup", (event) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) updateMentions();
    });
    input.addEventListener("blur", closeMentions);
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
    get uploading() {
      return pendingUploads > 0;
    },
    set value(text) {
      input.value = text;
      fitHeight();
      if (pendingUploads === 0) showStatus("");
      if (previewing) showPreview();
      onInput?.();
    },
    set disabled(value) {
      disabled = value;
      closeMentions();
      input.disabled = value;
      toolbar.querySelectorAll("md-icon-button").forEach((button) => {
        button.disabled = value;
      });
    },
    focus() {
      if (previewing) setPreviewing(false);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
    showWrite() {
      if (previewing) setPreviewing(false);
      else tabs.activeTabIndex = 0;
    }
  };
}
