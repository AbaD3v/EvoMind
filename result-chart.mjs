const SVG_NS = "http://www.w3.org/2000/svg";
let chartSequence = 0;

function svgNode(tag, attributes = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}

function shortLabel(value, length) {
  const characters = Array.from(value);
  return characters.length > length ? `${characters.slice(0, length - 1).join("")}…` : value;
}

function formatValue(value, unit, axis = false) {
  const magnitude = Math.abs(value);
  const scientific = magnitude >= 1e7 || (magnitude > 0 && magnitude < 0.001);
  return new Intl.NumberFormat("ru-RU", {
    notation: scientific ? "scientific" : "standard",
    maximumSignificantDigits: axis ? 3 : 17,
  }).format(Object.is(value, -0) ? 0 : value) + unit;
}

/** Render categorical numeric data without evaluating content or changing row order. */
export function renderResultChart({ points = [], unit = "", kind = "bar", labelTitle = "Категория", valueTitle = "Значение", availableWidth = 560 } = {}) {
  const values = (Array.isArray(points) ? points : []).filter(point => point && typeof point.value === "number" && Number.isFinite(point.value)).slice(0, 60);
  unit = unit === "%" ? "%" : "";
  kind = kind === "line" ? "line" : "bar";
  labelTitle = String(labelTitle);
  valueTitle = String(valueTitle);
  const figure = document.createElement("figure");
  figure.className = "result-chart";
  if (!values.length) {
    const empty = document.createElement("p");
    empty.className = "chart-tooltip";
    empty.textContent = "Нет числовых значений для диаграммы.";
    figure.append(empty);
    return figure;
  }

  // Normalize before subtraction: even opposite finite values near Number.MAX_VALUE
  // must never overflow the domain or produce Infinity/NaN coordinates.
  const scale = Math.max(...values.map(point => Math.abs(point.value))) || 1;
  const normalized = values.map(point => point.value / scale);
  const lower = Math.min(0, ...normalized);
  const upper = Math.max(0, ...normalized) || (lower === 0 ? 1 : 0);
  const span = upper - lower;
  const compactWidth = Number.isFinite(availableWidth) && availableWidth > 0 ? Math.max(280, availableWidth) : 560;
  const width = values.length > 8 ? 112 + values.length * 72 : compactWidth;
  const height = 320;
  const left = 88, right = 24, top = 36, bottom = 60;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const x = index => left + plotWidth * (index + 0.5) / values.length;
  const y = value => top + (upper - value) / span * plotHeight;
  const baseline = y(0);
  const id = `result-chart-${++chartSequence}`;
  const title = `${kind === "line" ? "Линейный график" : "Столбчатая диаграмма"}: ${valueTitle} по ${labelTitle}`;
  const svg = svgNode("svg", {
    viewBox: `0 0 ${width} ${height}`, role: "img", "aria-labelledby": `${id}-title`, "aria-describedby": `${id}-description`,
  });
  svg.style.display = "block";
  svg.style.width = "100%";
  if (values.length > 8) svg.style.minWidth = `${width}px`;
  svg.append(svgNode("title", { id: `${id}-title` }, title));
  svg.append(svgNode("desc", { id: `${id}-description` }, `Число значений: ${values.length}. Категории расположены в порядке строк таблицы на равном расстоянии. Ось значений включает ноль. Выберите элемент диаграммы, чтобы прочитать точное значение.`));
  const axisTitle = svgNode("text", { x: left, y: 18, class: "chart-axis-label", fill: "#aebbb6", "font-size": 12 }, shortLabel(valueTitle, Math.min(48, Math.floor(plotWidth / 7))));
  axisTitle.append(svgNode("title", {}, valueTitle));
  svg.append(axisTitle);

  const tickLabels = new Set();
  for (let index = 0; index <= 4; index++) {
    const tick = index === 4 ? upper : lower + span * index / 4;
    const text = formatValue(Math.max(-1, Math.min(1, tick)) * scale, unit, true);
    // Subnormal floating-point values can round several tick positions to zero.
    if (tickLabels.has(text)) continue;
    tickLabels.add(text);
    svg.append(svgNode("line", { x1: left, x2: width - right, y1: y(tick), y2: y(tick), class: "chart-grid", stroke: "#ffffff16", "stroke-dasharray": "4 5" }));
    svg.append(svgNode("text", { x: left - 12, y: y(tick) + 4, "text-anchor": "end", class: "chart-axis-label", fill: "#aebbb6", "font-size": 12 }, text));
  }
  svg.append(svgNode("line", { x1: left, x2: width - right, y1: baseline, y2: baseline, class: "chart-grid chart-zero", stroke: "#9baaa155", "stroke-width": 1.2 }));
  if (kind === "line" && values.length > 1) {
    svg.append(svgNode("polyline", {
      points: normalized.map((value, index) => `${x(index)},${y(value)}`).join(" "),
      class: "chart-line", fill: "none", stroke: "#9fe8cb", "stroke-width": 3, "stroke-linejoin": "round", "stroke-linecap": "round",
    }));
  }

  const readout = document.createElement("figcaption");
  readout.className = "chart-tooltip";
  readout.setAttribute("role", "status");
  readout.setAttribute("aria-live", "polite");
  readout.textContent = "Выберите точку или столбец, чтобы увидеть значение.";
  const marks = [];
  values.forEach((point, index) => {
    const label = String(point.label ?? index + 1);
    // Geometry uses finite numbers; the readout preserves the source cell even
    // when its decimal precision exceeds JavaScript's numeric representation.
    const readableValue = typeof point.rawValue === "string" ? point.rawValue.trim() : formatValue(point.value, unit);
    const accessibleLabel = `${label}: ${readableValue}`;
    const valueY = y(normalized[index]);
    const barWidth = Math.min(48, plotWidth / values.length * 0.6);
    const mark = kind === "line" || normalized[index] === 0
      ? svgNode("circle", { cx: x(index), cy: valueY, r: 5, class: "chart-point", fill: "#9fe8cb", stroke: "#101213", "stroke-width": 2 })
      : svgNode("rect", { x: x(index) - barWidth / 2, y: Math.min(valueY, baseline), width: barWidth, height: Math.abs(valueY - baseline), rx: Math.min(5, Math.abs(valueY - baseline) / 2), class: "chart-bar", fill: "#9fe8cb" });
    mark.setAttribute("tabindex", "0");
    mark.setAttribute("role", "button");
    mark.setAttribute("aria-label", accessibleLabel);
    mark.setAttribute("data-row-index", String(point.rowIndex ?? index));
    mark.append(svgNode("title", {}, accessibleLabel));
    marks.push(mark);
    const select = () => {
      for (const item of marks) item.classList.toggle("is-selected", item === mark);
      const value = document.createElement("strong");
      value.className = "chart-value";
      value.textContent = readableValue;
      readout.replaceChildren(document.createTextNode(`${label} — `), value);
    };
    mark.addEventListener("pointerenter", select);
    mark.addEventListener("focus", select);
    mark.addEventListener("click", select);
    mark.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); }
    });
    svg.append(mark);
    const labelLength = Math.max(2, Math.min(16, Math.floor(plotWidth / values.length / 7)));
    const category = svgNode("text", { x: x(index), y: height - bottom + 26, "text-anchor": "middle", class: "chart-axis-label", fill: "#aebbb6", "font-size": 12 }, shortLabel(label.replace(/\s+/gu, " "), labelLength));
    category.append(svgNode("title", {}, label));
    svg.append(category);
  });
  const viewport = document.createElement("div");
  viewport.className = "chart-scroll";
  viewport.style.overflowX = "auto";
  viewport.style.maxWidth = "100%";
  viewport.append(svg);
  figure.append(viewport, readout);
  return figure;
}
