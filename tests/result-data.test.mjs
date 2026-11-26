import test from "node:test";
import assert from "node:assert/strict";
import { parseNumericCell, numericColumns, chartSeries, toCSV } from "../result-data.mjs";

test("parses decimal comma, decimal dot and correctly grouped spaces without changing units", () => {
  for (const [raw, value, unit = ""] of [
    ["0", 0], ["12", 12], ["-42", -42], ["+12,5", 12.5],
    ["1,234", 1.234], ["1.234", 1.234], ["1 234,56", 1234.56],
    ["12\u00a0345\u00a0678.9", 12345678.9], ["1\u202f234,5", 1234.5],
    ["  -1 234,50  ", -1234.5], ["0,5%", 0.5, "%"],
    [" 12,5 % ", 12.5, "%"], ["-5\u00a0%", -5, "%"], ["100%", 100, "%"],
  ]) assert.deepEqual(parseNumericCell(raw), { value, unit }, raw);
});

test("rejects missing, invalid, ambiguous and unit-bearing values instead of coercing to zero", () => {
  for (const raw of [
    "", " ", "\u00a0", "—", "N/A", null, undefined, 0, false,
    "NaN", "Infinity", "-Infinity", "1e308", "1e-999", "0x10", "1/2",
    "12 34", "1234 567", "1  234", "1,234.56", "1.234,56", "1,2,3",
    "0012", "00,5", "0 123", "12.", ",5", "- 4", "1_000",
    "12 руб", "$12", "12 kg", "12‰", "12%%", "%12", "12 % extra",
    "\t-12", "12\n", "\u0000-12", "\u200b12", "9".repeat(129),
  ]) assert.equal(parseNumericCell(raw), null, String(raw));
});

test("numeric columns retain sparse values, exclude identifier zeros and reject percent/plain mixes", () => {
  const table = {
    headers: ["ID", "Выручка", "Доля", "Смешано", "Название", " "],
    rows: [
      ["001", "1 200,5", "10%", "10%", "Первый", "bad"],
      ["002", "", "", "20", "Второй", "7"],
      ["003", "неизвестно", "25 %", "", "Третий", ""],
    ],
  };
  assert.deepEqual(numericColumns(table), [
    { index: 1, label: "Выручка", unit: "" },
    { index: 2, label: "Доля", unit: "%" },
    { index: 5, label: "Столбец 6", unit: "" },
  ]);
  assert.deepEqual(chartSeries(table, 4, 3), { points: [], skipped: 3, unit: "" });
});

test("chart series preserves raw labels and row indices, skips missing labels/values and keeps real zero", () => {
  const table = {
    headers: ["Месяц", "Продажи"],
    rows: [[" Январь ", "1 200,5"], ["Февраль", "bad"], ["Март", ""], ["", "10"], ["Май", "0"], ["Июнь", "-5"]],
  };
  assert.deepEqual(chartSeries(table, 0, 1), {
    points: [
      { label: " Январь ", value: 1200.5, rowIndex: 0 },
      { label: "Май", value: 0, rowIndex: 4 },
      { label: "Июнь", value: -5, rowIndex: 5 },
    ], skipped: 3, unit: "",
  });
  assert.deepEqual(chartSeries({ headers: ["Доля"], rows: [["12,5%"], [""], ["100%"]] }, -1, 0), {
    points: [{ label: "1", value: 12.5, rowIndex: 0 }, { label: "3", value: 100, rowIndex: 2 }], skipped: 1, unit: "%",
  });
});

test("empty or nonnumeric tables and invalid selectors produce no invented points", () => {
  for (const table of [undefined, {}, { headers: [], rows: [] }, { headers: ["A"], rows: [["bad"], [""]] }]) {
    assert.deepEqual(numericColumns(table), []);
    assert.deepEqual(chartSeries(table, -1, 0), { points: [], skipped: table?.rows?.length ?? 0, unit: "" });
  }
  const table = { headers: ["A"], rows: [["12"]] };
  for (const [label, value] of [[-2, 0], [1, 0], [-1, -1], [-1, 1], [0, 0.5]]) {
    assert.deepEqual(chartSeries(table, label, value), { points: [], skipped: 1, unit: "" });
  }
});

test("CSV uses BOM, quoted escaped fields and CRLF while preserving the raw table text", () => {
  const table = { headers: ["Месяц", "Значение"], rows: [[" Январь ", "1 200,50"], ['Сказал "да"', "line 1\nline 2"], ["", "0%"]] };
  const snapshot = structuredClone(table);
  assert.equal(toCSV(table), '\uFEFF"Месяц","Значение"\r\n" Январь ","1 200,50"\r\n"Сказал ""да""","line 1\nline 2"\r\n"","0%"\r\n');
  assert.deepEqual(table, snapshot, "export does not mutate source data");
  assert.equal(toCSV({ headers: [], rows: [] }), "\uFEFF");
});

test("CSV protects formula prefixes in headers and data, including hidden whitespace/control prefixes", () => {
  const values = ["=1+1", " +SUM(A1)", "-1+2", "@SUM(A1)", "\t=1", "\r\n+1", "\u0000-12", "\u200b@A1", "\uFEFF=1", "-12 kg", "+42"];
  const escaped = (text) => '"' + text.replaceAll('"', '""') + '"';
  assert.equal(toCSV({ headers: ["=header"], rows: values.map((value) => [value]) }),
    "\uFEFF" + ["'=header", ...values.map((value) => "'" + value)].map(escaped).join("\r\n") + "\r\n");
});

test("CSV preserves strictly valid negative numeric cells and already protected text", () => {
  const values = ["-42", "-1 234,50", " -12,5 % ", "-0", "'-already protected", "normal = text"];
  assert.equal(toCSV({ headers: ["Value"], rows: values.map((value) => [value]) }),
    '\uFEFF"Value"\r\n' + values.map((value) => '"' + value + '"').join("\r\n") + "\r\n");
});
