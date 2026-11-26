import { highlightCode } from "./syntax-highlight.mjs";

// A deliberately small Markdown renderer. Model output is always text, never HTML.
// Unsupported constructs stay readable instead of executing embedded markup.
const MAX_NESTING = 8;

function node(tag, className, text) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

function safeUrl(value) {
  if (/\s|[\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

function readLink(text, start) {
  const labelEnd = text.indexOf("](", start + 1);
  if (labelEnd === -1) return null;
  let level = 1;
  for (let end = labelEnd + 2; end < text.length; end++) {
    if (text[end] === "\\") { end++; continue; }
    if (text[end] === "(") level++;
    if (text[end] === ")" && --level === 0) {
      return { label: text.slice(start + 1, labelEnd), url: text.slice(labelEnd + 2, end), end: end + 1 };
    }
  }
  return null;
}

function inline(parent, text, depth = 0) {
  if (depth >= MAX_NESTING) { parent.append(document.createTextNode(text)); return; }
  let plain = "";
  const flush = () => {
    if (plain) parent.append(document.createTextNode(plain));
    plain = "";
  };
  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (char === "\\" && /[\\`*_[\]{}()#+\-.!|>~]/.test(text[i + 1] ?? "")) {
      plain += text[i + 1]; i += 2; continue;
    }
    if (char === "\n") { flush(); parent.append(node("br")); i++; continue; }
    if (char === "`") {
      const delimiter = /^`+/.exec(text.slice(i))[0];
      const end = text.indexOf(delimiter, i + delimiter.length);
      if (end !== -1) {
        flush(); parent.append(node("code", "", text.slice(i + delimiter.length, end).replace(/\n/g, " ")));
        i = end + delimiter.length; continue;
      }
    }
    if (char === "[" && text[i - 1] !== "!") {
      const link = readLink(text, i);
      const url = link && safeUrl(link.url);
      if (url) {
        flush();
        const anchor = node("a");
        anchor.href = url;
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        // Link labels stay text to avoid nested links and misleading hidden markup.
        anchor.textContent = link.label;
        parent.append(anchor);
        i = link.end; continue;
      }
    }
    if (char === "<") {
      const end = text.indexOf(">", i + 1);
      const url = end !== -1 && safeUrl(text.slice(i + 1, end));
      if (url) {
        flush();
        const anchor = node("a", "", text.slice(i + 1, end));
        anchor.href = url; anchor.target = "_blank"; anchor.rel = "noopener noreferrer";
        parent.append(anchor); i = end + 1; continue;
      }
    }
    const delimiter = ["**", "__", "~~", "*", "_"].find((mark) => text.startsWith(mark, i));
    if (delimiter && !/\s/.test(text[i + delimiter.length] ?? " ") &&
        !(char === "_" && /[\p{L}\p{N}]/u.test(text[i - 1] ?? ""))) {
      const end = text.indexOf(delimiter, i + delimiter.length);
      if (end > i + delimiter.length && !/\s/.test(text[end - 1])) {
        flush();
        const span = node(delimiter === "~~" ? "del" : delimiter.length === 2 ? "strong" : "em");
        inline(span, text.slice(i + delimiter.length, end), depth + 1);
        parent.append(span); i = end + delimiter.length; continue;
      }
    }
    plain += char; i++;
  }
  flush();
}

export function renderCodeBlock(code, language = "") {
  const source = String(code ?? "");
  const label = /^[\w+#.-]{1,32}$/u.test(language) ? language : "Код";
  const block = node("div", "code-block");
  const toolbar = node("div", "code-toolbar");
  const copy = node("button", "code-copy", "Копировать код");
  copy.type = "button";
  copy.setAttribute("aria-live", "polite");
  let reset;
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(source);
      copy.dataset.copyState = "copied";
      copy.textContent = "Скопировано";
    } catch {
      copy.dataset.copyState = "error";
      copy.textContent = "Не удалось скопировать";
    }
    clearTimeout(reset);
    reset = setTimeout(() => {
      delete copy.dataset.copyState;
      copy.textContent = "Копировать код";
    }, 2200);
  });
  toolbar.append(node("span", "code-language", label), copy);
  const pre = node("pre", "code-content");
  pre.tabIndex = 0;
  pre.setAttribute("aria-label", label === "Код" ? "Блок кода" : `Код: ${label}`);
  const content = node("code");
  content.append(highlightCode(source, label));
  pre.append(content);
  block.append(toolbar, pre);
  return block;
}

function listItem(line) {
  const match = /^( *)([-+*]|\d{1,9}[.)])\s+(.+)$/.exec(line);
  return match && { indent: match[1].length, ordered: /\d/.test(match[2]), start: parseInt(match[2], 10), text: match[3] };
}

function cells(line) {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);
  const result = [];
  let cell = "", code = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\\" && value[i + 1] === "|") { cell += "\\|"; i++; continue; }
    if (value[i] === "`") {
      const tick = /^`+/.exec(value.slice(i))[0];
      if (!code) code = tick; else if (code === tick) code = "";
      cell += tick; i += tick.length - 1; continue;
    }
    if (value[i] === "|" && !code) { result.push(cell.trim()); cell = ""; }
    else cell += value[i];
  }
  result.push(cell.trim());
  return result;
}

function tableSpec(lines, start) {
  if (!lines[start]?.includes("|") || !lines[start + 1]?.includes("|")) return null;
  const headers = cells(lines[start]), separators = cells(lines[start + 1]);
  if (headers.length !== separators.length || !separators.every((cell) => /^:?-{3,}:?$/.test(cell))) return null;
  return { headers, align: separators.map((cell) => cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "left") };
}

function renderTable(lines, start, spec) {
  const wrap = node("div", "markdown-table-wrap");
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "region");
  wrap.setAttribute("aria-label", "Таблица в ответе, доступна горизонтальная прокрутка");
  const table = node("table", "markdown-table"), head = node("thead"), body = node("tbody");
  const row = (values, header = false) => {
    const tr = node("tr");
    values.forEach((value, index) => {
      const cell = node(header ? "th" : "td");
      if (header) cell.scope = "col";
      cell.dataset.align = spec.align[index];
      inline(cell, value); tr.append(cell);
    });
    return tr;
  };
  head.append(row(spec.headers, true));
  let end = start + 2;
  while (end < lines.length && lines[end].includes("|")) {
    const values = cells(lines[end]);
    if (values.length !== spec.headers.length) break;
    body.append(row(values)); end++;
  }
  table.append(head, body); wrap.append(table);
  return { element: wrap, end };
}

function renderList(lines, start, depth) {
  const first = listItem(lines[start]);
  const list = node(first.ordered ? "ol" : "ul");
  // Preserve list semantics in browsers that hide them with custom CSS markers.
  list.setAttribute("role", "list");
  if (first.ordered && first.start !== 1) list.start = first.start;
  let end = start;
  while (end < lines.length) {
    const item = listItem(lines[end]);
    if (!item || item.indent !== first.indent || item.ordered !== first.ordered) break;
    const content = [item.text];
    end++;
    while (end < lines.length) {
      const next = listItem(lines[end]);
      if (next && next.indent === first.indent) break;
      if (!lines[end].trim()) {
        const following = lines[end + 1];
        const nextItem = following && listItem(following);
        if (nextItem?.indent === first.indent && nextItem.ordered === first.ordered) { end++; break; }
        if (following && following.search(/\S/) > first.indent) { content.push(""); end++; continue; }
        break;
      }
      const indent = lines[end].search(/\S/);
      if (indent <= first.indent) break;
      content.push(lines[end].slice(Math.min(indent, first.indent + 2))); end++;
    }
    const li = node("li");
    blocks(li, content, depth + 1); list.append(li);
  }
  return { element: list, end };
}

const fenceStart = (line) => /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/.exec(line);
const heading = (line) => /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/.exec(line);
const rule = (line) => /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line);
const quote = (line) => /^ {0,3}>\s?/.test(line);
const startsBlock = (lines, i) => fenceStart(lines[i]) || heading(lines[i]) || rule(lines[i]) || quote(lines[i]) || listItem(lines[i]) || tableSpec(lines, i);

function blocks(parent, lines, depth = 0) {
  if (depth >= MAX_NESTING) {
    const paragraph = node("p"); inline(paragraph, lines.join("\n")); parent.append(paragraph); return;
  }
  for (let i = 0; i < lines.length;) {
    if (!lines[i].trim()) { i++; continue; }
    const fence = fenceStart(lines[i]);
    if (fence) {
      const content = [], mark = fence[1][0], count = fence[1].length;
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${mark}{${count},}\\s*$`).test(lines[i])) content.push(lines[i++]);
      if (i < lines.length) i++;
      parent.append(renderCodeBlock(content.join("\n"), fence[2])); continue;
    }
    const title = heading(lines[i]);
    if (title) {
      const h = node(`h${Math.min(6, Math.max(3, title[1].length + 1))}`);
      inline(h, title[2]); parent.append(h); i++; continue;
    }
    if (rule(lines[i])) { parent.append(node("hr")); i++; continue; }
    const table = tableSpec(lines, i);
    if (table) {
      const result = renderTable(lines, i, table); parent.append(result.element); i = result.end; continue;
    }
    if (quote(lines[i])) {
      const content = [];
      while (i < lines.length && quote(lines[i])) content.push(lines[i++].replace(/^ {0,3}>\s?/, ""));
      const block = node("blockquote"); blocks(block, content, depth + 1); parent.append(block); continue;
    }
    if (listItem(lines[i])) {
      const result = renderList(lines, i, depth); parent.append(result.element); i = result.end; continue;
    }
    const content = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) content.push(lines[i++]);
    const paragraph = node("p"); inline(paragraph, content.join("\n")); parent.append(paragraph);
  }
}

export function renderMarkdown(text) {
  const root = node("div", "answer-markdown");
  blocks(root, String(text ?? "").replace(/\r\n?/g, "\n").split("\n"));
  return root;
}
