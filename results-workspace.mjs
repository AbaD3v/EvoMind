import { numericColumns, chartSeries, toCSV } from "./result-data.mjs";
import { renderResultChart } from "./result-chart.mjs";

const TABLE_LIMIT = 500;
const CHART_LIMIT = 60;
const byId = (id) => document.getElementById(id);
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const headingText = (value, fallback) => value.trim() || fallback;

export function createResultsWorkspace() {
  const panel = byId("results-panel");
  const compact = matchMedia("(max-width: 1199px)");
  const tabs = [byId("results-tab-table"), byId("results-tab-chart")];
  const labelSelect = byId("results-label");
  const valueSelect = byId("results-value");
  const kindSelect = byId("results-kind");
  const chartMount = byId("results-chart");
  let current;
  let opener;
  let chartWidth = 0;
  const chartSizer = new ResizeObserver(([entry]) => {
    const width = Math.floor(entry.contentRect.width);
    if (width <= 0 || width === chartWidth || !panel.open || byId("results-chart-view").hidden) return;
    chartWidth = width;
    const focusedRow = chartMount.contains(document.activeElement) ? document.activeElement.dataset.rowIndex : undefined;
    drawChart();
    if (focusedRow !== undefined) {
      [...chartMount.querySelectorAll("[data-row-index]")].find((mark) => mark.dataset.rowIndex === focusedRow)?.focus({ preventScroll: true });
    }
  });
  chartSizer.observe(chartMount);

  function returnTarget() {
    return opener?.isConnected && opener.getClientRects().length && !opener.closest("[inert]") ? opener : byId("question");
  }

  function showPanel() {
    document.body.classList.add("results-open");
    panel.setAttribute("aria-modal", String(compact.matches));
    if (compact.matches) panel.showModal();
    else panel.show();
  }

  function close({ restoreFocus = true } = {}) {
    if (!panel.open) return;
    panel.close();
    document.body.classList.remove("results-open");
    if (restoreFocus) returnTarget().focus({ preventScroll: true });
    current = undefined;
  }

  panel.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  panel.addEventListener("close", () => {
    // A breakpoint change closes and immediately reopens the same dialog.
    if (!panel.open) document.body.classList.remove("results-open");
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  });
  byId("results-close").onclick = () => close();
  compact.addEventListener("change", () => {
    if (!panel.open) return;
    const otherModal = document.querySelector("dialog:modal:not(#results-panel)");
    if (otherModal) {
      const focused = document.activeElement;
      close({ restoreFocus: false });
      if (otherModal.contains(focused)) focused.focus({ preventScroll: true });
      return;
    }
    const focused = panel.contains(document.activeElement) ? document.activeElement : byId("results-close");
    panel.close();
    showPanel();
    focused.focus({ preventScroll: true });
  });

  function setTab(index, focus = false) {
    tabs.forEach((tab, position) => {
      tab.setAttribute("aria-selected", String(position === index));
      tab.tabIndex = position === index ? 0 : -1;
    });
    byId("results-table-view").hidden = index !== 0;
    byId("results-chart-view").hidden = index !== 1;
    if (index === 1) drawChart();
    if (focus) tabs[index].focus();
  }
  tabs.forEach((tab, index) => {
    tab.onclick = () => setTab(index);
    tab.onkeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      setTab(event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index, true);
    };
  });

  function fillSelect(select, choices) {
    select.replaceChildren(...choices.map(({ index, label }) => {
      const option = node("option", "", label);
      option.value = String(index);
      return option;
    }));
  }

  function drawChart() {
    if (!current) return;
    const { table, columns } = current;
    const chart = byId("results-chart");
    const empty = byId("results-chart-empty");
    const note = byId("results-chart-note");
    empty.querySelector("strong").textContent = "Для графика нужны числа";
    empty.querySelector("p").textContent = "Эту таблицу можно просмотреть и скачать. Для графика добавь числовой столбец с одной единицей измерения.";
    chart.replaceChildren();
    byId("results-controls").hidden = columns.length === 0;
    empty.hidden = columns.length > 0;
    byId("results-chart-caption").hidden = columns.length === 0;
    note.textContent = "";
    if (!columns.length) return;
    const series = chartSeries(table, Number(labelSelect.value), Number(valueSelect.value));
    empty.hidden = series.points.length > 0;
    byId("results-chart-caption").hidden = series.points.length === 0;
    if (!series.points.length) {
      empty.querySelector("strong").textContent = "В выбранном столбце нет подписей";
      empty.querySelector("p").textContent = "Выбери другой столбец подписей или «Номер строки», чтобы построить график.";
      return;
    }
    const valueTitle = valueSelect.selectedOptions[0].textContent;
    const labelTitle = labelSelect.selectedOptions[0].textContent;
    byId("results-chart-caption").textContent = `${valueTitle} · ${labelTitle}`;
    chart.append(renderResultChart({
      points: series.points.slice(0, CHART_LIMIT), unit: series.unit,
      kind: kindSelect.value, labelTitle, valueTitle, availableWidth: chartMount.clientWidth,
    }));
    const notes = [];
    if (series.skipped) notes.push(`Пропущено строк без числового значения или подписи: ${series.skipped}.`);
    if (series.points.length > CHART_LIMIT) notes.push(`Показаны первые ${CHART_LIMIT} из ${series.points.length} значений. Все строки доступны в CSV.`);
    if (kindSelect.value === "line") notes.push("Точки расположены в порядке строк, с одинаковым расстоянием между ними.");
    note.textContent = notes.join(" ");
  }
  for (const select of [labelSelect, valueSelect, kindSelect]) select.onchange = drawChart;

  function renderTable(table) {
    const result = node("table", "results-table");
    const caption = node("caption", "", current.title);
    const head = node("thead"), body = node("tbody");
    const numeric = new Set(current.columns.map((column) => column.index));
    function row(values, header) {
      const tr = node("tr");
      values.forEach((value, index) => {
        const cell = node(header ? "th" : "td", "", value);
        if (header) cell.scope = "col";
        if (numeric.has(index)) cell.dataset.numeric = "true";
        tr.append(cell);
      });
      return tr;
    }
    head.append(row(table.headers, true));
    body.append(...table.rows.slice(0, TABLE_LIMIT).map((values) => row(values, false)));
    result.append(caption, head, body);
    byId("results-table-scroll").replaceChildren(result);
    const note = byId("results-table-note");
    note.hidden = table.rows.length > 0 && table.rows.length <= TABLE_LIMIT;
    note.textContent = table.rows.length === 0 ? "В таблице пока только заголовки, строк с данными нет."
      : `Показаны первые ${TABLE_LIMIT} строк. CSV содержит все ${table.rows.length}.`;
  }

  function open(table, { title = "Таблица", source = "", trigger, demo = false, view = "table" } = {}) {
    const columns = numericColumns(table);
    current = { table, columns, title, demo };
    opener = trigger;
    byId("results-title").textContent = title;
    byId("results-source").textContent = source;
    byId("results-meta").textContent = `${table.rows.length} строк · ${table.headers.length} столбцов`;
    byId("results-status").textContent = "";
    byId("results-origin").textContent = demo ? "Учебные данные · пример" : "Данные из ответа EvoMind";
    byId("results-source-link").textContent = demo ? "К чату ↗" : "К ответу ↗";
    fillSelect(labelSelect, [{ index: -1, label: "Номер строки" }, ...table.headers.map((label, index) => ({ index, label: headingText(label, `Столбец ${index + 1}`) }))]);
    fillSelect(valueSelect, columns);
    const nonNumeric = table.headers.findIndex((_, index) => !columns.some((column) => column.index === index)
      && table.rows.some((row) => row[index]?.trim()));
    labelSelect.value = String(nonNumeric);
    valueSelect.value = String(columns[0]?.index ?? "");
    kindSelect.value = "bar";
    renderTable(table);
    setTab(view === "chart" ? 1 : 0);
    if (!panel.open) showPanel();
    byId("results-close").focus({ preventScroll: true });
    byId("results-table-scroll").scrollTo(0, 0);
    panel.querySelector(".results-body").scrollTop = 0;
  }

  byId("results-source-link").onclick = () => {
    close();
    const target = returnTarget();
    target.scrollIntoView({ block: "center", behavior: "instant" });
    target.focus({ preventScroll: true });
  };
  byId("results-download").onclick = () => {
    if (!current) return;
    let url;
    try {
      const blob = new Blob([toCSV(current.table)], { type: "text/csv;charset=utf-8" });
      url = URL.createObjectURL(blob);
      const link = node("a");
      link.href = url;
      link.download = current.demo ? "evomind-example.csv" : "evomind-result.csv";
      document.body.append(link);
      link.click();
      link.remove();
      byId("results-status").textContent = "CSV подготовлен для скачивания.";
    } catch {
      byId("results-status").textContent = "Не удалось подготовить CSV. Попробуй скачать ещё раз.";
    } finally {
      if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  };

  function enhance(container, source = "") {
    let title = "", index = 0;
    for (const item of container.querySelectorAll("h3,h4,h5,h6,table.markdown-table")) {
      if (item.localName !== "table") { title = item.textContent; continue; }
      index++;
      const table = {
        headers: [...item.tHead.rows[0].cells].map((cell) => cell.textContent),
        rows: [...item.tBodies[0].rows].map((row) => [...row.cells].map((cell) => cell.textContent)),
      };
      const tableTitle = title || `Таблица ${index}`;
      const toolbar = node("div", "result-table-toolbar");
      const button = node("button", "open-result", "Открыть результат ↗");
      button.type = "button";
      button.setAttribute("aria-haspopup", "dialog");
      button.setAttribute("aria-controls", "results-panel");
      button.onclick = () => open(table, { title: tableTitle, source, trigger: button });
      toolbar.append(node("span", "", `Таблица · ${table.rows.length} строк`), button);
      item.closest(".markdown-table-wrap").before(toolbar);
    }
  }

  byId("result-demo").onclick = (event) => open({
    headers: ["Эксперимент", "Точность, %", "Время, мин"],
    rows: [["A", "72", "4,2"], ["B", "78", "5,1"], ["C", "84", "6,8"], ["D", "88", "8,4"]],
  }, { title: "Сравнение экспериментов", source: "Демонстрационный набор, не результаты вашей модели.", trigger: event.currentTarget, demo: true, view: "chart" });

  return { enhance, close };
}
