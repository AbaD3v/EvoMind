const CARD_TAGS = new Set(["article", "section", "header", "footer", "main", "div", "span", "p",
  "h1", "h2", "h3", "h4", "ul", "ol", "li", "strong", "em", "small", "b", "i", "code", "blockquote", "hr", "br"]);
const BLOCKED_CSS = /<|@import\b|\burl\s*\(/i;

export function renderHtmlCard(result, sourceLink) {
  if (typeof result.html !== "string" || !result.html || result.html.length > 4400 ||
      typeof result.css !== "string" || !result.css.trim() || result.css.length > 3200 || BLOCKED_CSS.test(result.css)) {
    return null;
  }
  const fragment = document.createElement("template");
  fragment.innerHTML = result.html;
  for (const node of fragment.content.querySelectorAll("*")) {
    if (node.namespaceURI !== "http://www.w3.org/1999/xhtml" || !CARD_TAGS.has(node.localName)) {
      node.remove();
      continue;
    }
    for (const name of node.getAttributeNames()) {
      if (name !== "class" && name !== "id") node.removeAttribute(name);
    }
  }
  if (!fragment.content.textContent.trim()) return null;

  const frame = document.createElement("iframe");
  frame.className = "html-card-frame";
  frame.title = typeof result.title === "string" ? result.title : "Карточка EvoMind";
  frame.loading = "lazy";
  frame.setAttribute("sandbox", "");
  frame.referrerPolicy = "no-referrer";
  const height = Number.isInteger(result.height) ? result.height : 360;
  frame.height = String(Math.max(240, Math.min(720, height)));
  frame.srcdoc = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{margin:0;font:16px system-ui,sans-serif;overflow-wrap:anywhere}${result.css}</style>
    </head><body>${fragment.innerHTML}</body></html>`;

  const card = document.createElement("div");
  card.className = "html-card";
  card.append(frame, sourceLink);
  return card;
}
