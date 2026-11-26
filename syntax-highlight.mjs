const MAX_SOURCE = 24_000;
const MAX_TOKENS = 1_500;
const PYTHON_WORDS = new Set(("False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case").split(" "));
const JSON_WORDS = new Set(["true", "false", "null"]);
const IDENTIFIER = /[A-Za-z_$][\w$]*/y;
const NUMBER = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)[jJ]?/y;
const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

function matchAt(pattern, source, start) {
  pattern.lastIndex = start;
  return pattern.exec(source)?.[0];
}

function stringEnd(source, start, python) {
  const quote = source[start];
  const delimiter = python && source.startsWith(quote.repeat(3), start) ? quote.repeat(3) : quote;
  let end = start + delimiter.length;
  while (end < source.length) {
    if (source[end] === "\\") { end = Math.min(source.length, end + 2); continue; }
    if (source.startsWith(delimiter, end)) return end + delimiter.length;
    if (delimiter.length === 1 && /[\r\n]/.test(source[end])) return end;
    end++;
  }
  return end;
}

// This is lexical coloring, not a parser. Scan strings/comments first and never
// interpret their contents as code. Both input and DOM growth have fixed limits.
function tokens(source, python) {
  const found = [];
  for (let i = 0; i < source.length;) {
    const start = i;
    let type;
    const char = source[i];
    if (python && char === "#") {
      const newline = source.indexOf("\n", i);
      i = newline === -1 ? source.length : newline;
      type = "comment";
    } else if (char === '"' || (python && char === "'")) {
      i = stringEnd(source, i, python);
      type = "string";
    } else {
      const word = /[A-Za-z_$]/.test(char) && matchAt(IDENTIFIER, source, i);
      if (word) {
        i += word.length;
        if (python && /^(?:r|u|b|f|br|rb|fr|rf)$/i.test(word) && /["']/.test(source[i] ?? "")) {
          i = stringEnd(source, i, true);
          type = "string";
        } else if ((python ? PYTHON_WORDS : JSON_WORDS).has(word)) {
          type = "keyword";
        } else if (python) {
          let next = i;
          while (next < source.length && /\s/.test(source[next])) next++;
          if (source[next] === "(") type = "function";
        }
      } else {
        const number = /[\d.-]/.test(char) && matchAt(python ? NUMBER : JSON_NUMBER, source, i);
        if (number) { i += number.length; type = "number"; }
        else i++;
      }
    }
    if (type) found.push({ start, end: i, type });
    if (found.length > MAX_TOKENS) return null;
  }
  return found;
}

export function highlightCode(source, language) {
  const fragment = document.createDocumentFragment();
  const normalized = language.toLowerCase();
  const python = ["python", "py", "python3"].includes(normalized);
  const ranges = source.length <= MAX_SOURCE && (python || normalized === "json") ? tokens(source, python) : null;
  if (!ranges) {
    fragment.append(document.createTextNode(source));
    return fragment;
  }
  let offset = 0;
  for (const { start, end, type } of ranges) {
    if (start > offset) fragment.append(document.createTextNode(source.slice(offset, start)));
    const span = document.createElement("span");
    span.className = `syntax-${type}`;
    span.textContent = source.slice(start, end);
    fragment.append(span);
    offset = end;
  }
  if (offset < source.length) fragment.append(document.createTextNode(source.slice(offset)));
  return fragment;
}
