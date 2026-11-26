const CELL_LIMIT = 128;
const EDGE_SPACE = /^[ \u00a0\u202f]+|[ \u00a0\u202f]+$/g;
const GROUP_SPACE = /[ \u00a0\u202f]/g;
// Comma and dot are decimal separators only. Grouping is permitted only in
// groups of three separated by spaces. Leading zeros and exponents are left
// as text because table identifiers and locale conventions can be ambiguous.
const DECIMAL = /^([+-]?)((?:0|[1-9]\d*|[1-9]\d{0,2}(?:[ \u00a0\u202f]\d{3})+)(?:[.,]\d+)?)(?:[ \u00a0\u202f]*(%))?$/;
const FORMULA_PREFIX = /^[\s\p{Cc}\p{Cf}]*[=+\-@]/u;

export function parseNumericCell(raw) {
  if (typeof raw !== "string" || raw.length > CELL_LIMIT) return null;
  const trimmed = raw.replace(EDGE_SPACE, "");
  const match = DECIMAL.exec(trimmed);
  if (!match) return null;
  const number = match[1] + match[2].replace(GROUP_SPACE, "").replace(",", ".");
  const value = Number(number);
  if (!Number.isFinite(value) || (value === 0 && /[1-9]/.test(match[2]))) return null;
  return { value, unit: match[3] ? "%" : "" };
}

function readTable(table) {
  return {
    headers: Array.isArray(table?.headers) ? table.headers : [],
    rows: Array.isArray(table?.rows) ? table.rows : [],
  };
}

function cell(row, index) {
  return Array.isArray(row) && typeof row[index] === "string" ? row[index] : "";
}

function readColumn(rows, index) {
  const values = rows.map((row) => parseNumericCell(cell(row, index)));
  const units = new Set(values.filter(Boolean).map((item) => item.unit));
  return { values, unit: units.size === 1 ? units.values().next().value : "", usable: units.size === 1 };
}

export function numericColumns(table) {
  const { headers, rows } = readTable(table);
  return headers.flatMap((header, index) => {
    const column = readColumn(rows, index);
    if (!column.usable) return [];
    const label = typeof header === "string" && header.trim() ? header : `Столбец ${index + 1}`;
    return [{ index, label, unit: column.unit }];
  });
}

export function chartSeries(table, labelIndex, valueIndex) {
  const { headers, rows } = readTable(table);
  const empty = { points: [], skipped: rows.length, unit: "" };
  if (!Number.isInteger(valueIndex) || valueIndex < 0 || valueIndex >= headers.length ||
      !Number.isInteger(labelIndex) || labelIndex < -1 || labelIndex >= headers.length) return empty;
  const column = readColumn(rows, valueIndex);
  if (!column.usable) return empty;
  const points = [];
  rows.forEach((row, rowIndex) => {
    const parsed = column.values[rowIndex];
    const label = labelIndex === -1 ? String(rowIndex + 1) : cell(row, labelIndex);
    if (parsed && label.trim()) points.push({ label, value: parsed.value, rawValue: cell(row, valueIndex), rowIndex });
  });
  return { points, skipped: rows.length - points.length, unit: column.unit };
}

function csvCell(raw) {
  let text = typeof raw === "string" ? raw : "";
  if (FORMULA_PREFIX.test(text)) {
    // Keep genuine negative decimals numeric. Control-prefixed values, arbitrary
    // units and expressions such as -1+2 fail strict parsing and stay protected.
    const negativeNumber = text.replace(EDGE_SPACE, "").startsWith("-") && parseNumericCell(text);
    if (!negativeNumber) text = "'" + text;
  }
  return '"' + text.replaceAll('"', '""') + '"';
}

export function toCSV(table) {
  const { headers, rows } = readTable(table);
  const records = headers.length ? [headers, ...rows] : rows;
  if (!records.length) return "\uFEFF";
  return "\uFEFF" + records.map((row) => (Array.isArray(row) ? row : []).map(csvCell).join(",")).join("\r\n") + "\r\n";
}
