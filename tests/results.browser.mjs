import { readFile } from "node:fs/promises";

const fixture = [
  "## Эксперименты", "",
  "| Эксперимент | Точность | Изменение | Примечание | Пустая подпись |", "| --- | --- | --- | --- | --- |",
  '| A, "база" | 72% | -12,5 | Старт | |',
  "| B | 78% | 0 | =SUM(A1:A2) | |",
  "| C | 84% | 18 | <img src=x onerror=alert(1)> | |",
  "| D | 88% | | Нет изменения | |", "",
  "## Словарь", "",
  "| Термин | Объяснение |", "| --- | --- |",
  "| **Модель** | Проверенный текст |",
  "| Ссылка | [Документация](https://example.com) |",
].join("\n");

export async function runResultsChecks(browser, base, assert) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", acceptDownloads: true });
  const external = [], errors = [];
  await context.route("**/*", route => {
    if (route.request().url().startsWith(base + "/")) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await context.addInitScript(text => {
    if (localStorage.getItem("evomind.chats.v1")) return;
    localStorage.setItem("evomind.chats.v1", JSON.stringify([{
      id: "results-fixture", title: "Сравни эксперименты", turns: [{
        id: "results-answer", question: "Сравни эксперименты", steps: [], answer: { ok: true, text },
      }],
    }]));
  }, fixture);
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", error => errors.push(error.message));
  const panel = page.locator("#results-panel");
  const isOpen = () => panel.evaluate(element => element.open);
  const openFirst = () => page.locator(".open-result").first().click();
  const activeIs = selector => page.locator(selector).evaluate(element => element === document.activeElement);
  try {
    await page.goto(base);
    await page.waitForFunction(() => !document.querySelector("#hf-account").disabled);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator(".open-result").count(), 2, "every successful answer table opens independently");
    await openFirst();
    assert.equal(await isOpen(), true);
    assert.equal(await panel.getAttribute("aria-modal"), "false");
    assert.equal(await page.locator("#results-title").textContent(), "Эксперименты");
    assert.deepEqual(await page.locator(".results-table tbody tr").evaluateAll(rows => rows.map(row => [...row.cells].map(cell => cell.textContent))), [
      ['A, "база"', "72%", "-12,5", "Старт", ""], ["B", "78%", "0", "=SUM(A1:A2)", ""],
      ["C", "84%", "18", "<img src=x onerror=alert(1)>", ""], ["D", "88%", "", "Нет изменения", ""],
    ]);
    assert.equal(await panel.locator("img,script").count(), 0, "table cells stay text");
    await page.screenshot({ path: "test-results/results-table.png" });
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#results-download").click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), "evomind-result.csv");
    const csv = await readFile(await download.path(), "utf8");
    assert.ok(csv.startsWith("\uFEFF"), "CSV includes a UTF-8 BOM for spreadsheet apps");
    assert.ok(csv.includes('"A, ""база""","72%","-12,5"'), "CSV preserves quoted labels and decimals");
    assert.ok(csv.includes('"\'=SUM(A1:A2)"'), "formula-like text is neutralized");
    assert.ok(csv.includes('"<img src=x onerror=alert(1)>"'), "CSV keeps ordinary cell text");

    await page.locator("#results-tab-table").focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await activeIs("#results-tab-chart"), true, "tabs support arrow-key navigation");
    assert.equal(await page.locator("#results-tab-chart").getAttribute("aria-selected"), "true");
    assert.deepEqual(await page.locator("#results-value option").evaluateAll(options => options.map(option => option.value)), ["1", "2"]);
    assert.equal(await page.locator("#results-chart [role=button]").count(), 4);
    await page.locator("#results-chart [role=button]").first().focus();
    assert.match(await page.locator(".chart-value").innerText(), /72%/);
    await page.screenshot({ path: "test-results/results-desktop.png" });

    await page.locator("#results-label").selectOption("4");
    assert.equal(await page.locator("#results-chart-empty").isVisible(), true, "blank categories explain why no points are shown");
    assert.equal(await page.locator("#results-chart-caption").isVisible(), false);
    await page.locator("#results-label").selectOption("-1");
    assert.equal(await page.locator("#results-chart [role=button]").count(), 4, "row numbers recover blank labels");
    await page.locator("#results-label").selectOption("0");

    await page.locator("#results-value").selectOption("2");
    assert.equal(await page.locator("#results-chart [role=button]").count(), 3, "blank metric is omitted");
    assert.match(await page.locator("#results-chart-note").innerText(), /Пропущено.*1/);
    const bars = await page.locator("#results-chart").evaluate(element => {
      const zero = Number(element.querySelector(".chart-zero").getAttribute("y1"));
      return [...element.querySelectorAll(".chart-bar")].map(bar => ({ y: Number(bar.getAttribute("y")), height: Number(bar.getAttribute("height")), zero }));
    });
    assert.ok(bars.some(bar => bar.y === bar.zero && bar.height > 0), "negative value extends below zero");
    assert.ok(bars.some(bar => bar.y < bar.zero && bar.height > 0), "positive value extends above zero");
    await page.locator("#results-kind").selectOption("line");
    assert.equal(await page.locator(".chart-line").count(), 1);
    assert.equal(await page.locator(".chart-point").count(), 3);
    assert.match(await page.locator("#results-chart-note").innerText(), /порядке строк/);
    await page.locator("#results-label").selectOption("-1");
    await page.locator(".chart-point").first().focus();
    assert.match(await page.locator(".chart-tooltip").innerText(), /^1 — -12,5$/);

    for (const width of [320, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForFunction(width => document.querySelector("#results-panel").getAttribute("aria-modal") === String(width < 1200), width);
      await page.waitForFunction(() => Math.abs(document.querySelector("#results-chart svg").viewBox.baseVal.width - Math.max(280, document.querySelector("#results-chart").clientWidth)) < 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `results page fits ${width}px`);
      assert.equal(await isOpen(), true, "resize preserves the open result");
      assert.equal(await page.locator("#results-value").inputValue(), "2");
      assert.equal(await page.locator("#results-kind").inputValue(), "line");
      assert.equal(await page.locator("#results-tab-chart").getAttribute("aria-selected"), "true");
      assert.equal(await panel.getAttribute("aria-modal"), String(width < 1200));
      assert.equal(await page.locator(".chart-scroll").evaluate(element => element.scrollWidth > element.clientWidth + 1), false, `short chart fits ${width}px`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.querySelector("#results-panel").getAttribute("aria-modal") === "true");
    assert.equal(await page.evaluate(() => {
      document.querySelector("#question").focus();
      return document.querySelector("#results-panel").matches(":modal") && document.activeElement !== document.querySelector("#question");
    }), true, "native modal makes background controls unfocusable");
    for (let index = 0; index < 18; index++) {
      await page.keyboard.press("Tab");
      const focus = await panel.evaluate(element => ({ inside: element.contains(document.activeElement), id: document.activeElement.id, tag: document.activeElement.localName }));
      // Native dialogs allow a transition to browser chrome (reported as body),
      // but no interactive background element may enter the tab order.
      assert.ok(focus.inside || focus.tag === "body", `modal background is excluded at Tab ${index + 1}: ${JSON.stringify(focus)}`);
    }
    await page.locator("#results-value").selectOption("1");
    await page.locator("#results-label").selectOption("0");
    await page.locator("#results-kind").selectOption("bar");
    assert.equal(await page.locator(".chart-scroll").evaluate(element => element.scrollWidth > element.clientWidth + 1), false, "four mobile bars fit without horizontal scrolling");
    await page.screenshot({ path: "test-results/results-mobile.png" });
    await page.keyboard.press("Escape");
    assert.equal(await isOpen(), false);
    assert.equal(await page.locator(".open-result").first().evaluate(element => element === document.activeElement), true, "closing restores the source button");

    await page.setViewportSize({ width: 1440, height: 1000 });
    await openFirst();
    await page.locator("#results-source-link").click();
    assert.equal(await isOpen(), false);
    assert.equal(await page.locator(".open-result").first().evaluate(element => element === document.activeElement), true);
    await openFirst();
    await page.locator("#chat-menu > summary").click();
    await page.locator("#rename-chat").click();
    assert.equal(await activeIs("#rename-value"), true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => !document.querySelector("#results-panel").open);
    assert.equal(await page.locator("#rename-dialog").evaluate(element => element.matches(":modal")), true, "responsive result does not cover an existing modal");
    assert.equal(await activeIs("#rename-value"), true, "renaming keeps focus when results close at a breakpoint");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#rename-dialog").evaluate(element => element.open), false);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator(".open-result").nth(1).click();
    assert.equal(await page.locator("#results-title").innerText(), "Словарь");
    assert.equal(await page.locator(".results-table tbody tr").first().locator("td").first().textContent(), "Модель", "table uses rendered plain text");
    await page.locator("#results-tab-chart").click();
    assert.equal(await page.locator("#results-chart-empty").isVisible(), true);
    assert.equal(await page.locator("#results-controls").isVisible(), false);
    assert.equal(await page.locator("#results-chart svg").count(), 0);
    await page.locator("#new-chat").click();
    assert.equal(await isOpen(), false, "changing chats closes the prior result");

    const historyBeforeDemo = await page.evaluate(() => localStorage.getItem("evomind.chats.v1"));
    const requestsBeforeDemo = external.length;
    await page.locator("#result-demo").click();
    assert.match(await page.locator("#results-origin").innerText(), /Учебные данные/);
    assert.match(await page.locator("#results-source").innerText(), /не результаты вашей модели/);
    assert.equal(await page.locator("#results-chart [role=button]").count(), 4);
    assert.equal(await page.evaluate(() => localStorage.getItem("evomind.chats.v1")), historyBeforeDemo, "demo does not alter chat history");
    assert.equal(external.length, requestsBeforeDemo, "demo makes no remote model request");
    assert.equal(await page.locator(".turn").count(), 0);
    // Sending a first message can hide the welcome card while its desktop demo
    // stays open. A hidden opener must not receive focus on close.
    await page.locator("#empty").evaluate(element => { element.hidden = true; });
    await page.locator("#results-close").click();
    assert.equal(await activeIs("#question"), true);
    await page.locator("#empty").evaluate(element => { element.hidden = false; });
    await page.locator(".history-entry").filter({ hasText: "Сравни эксперименты" }).click();
    await page.reload();
    await page.waitForSelector(".open-result");
    assert.equal(await page.locator(".open-result").count(), 2, "saved history restores result actions");
    await openFirst();
    assert.equal(await page.locator(".results-table tbody tr").count(), 4);

    const edgeCases = await page.evaluate(async () => {
      const { renderResultChart } = await import("./result-chart.mjs");
      let checked = 0;
      for (const values of [[0, 0], [5], [-1e308, 0, 1e308], [Number.MIN_VALUE, Number.MIN_VALUE * 2]]) {
        for (const kind of ["bar", "line"]) {
          const figure = renderResultChart({ points: values.map((value, index) => ({ label: `<svg onload=alert(1)>${index}`, value })), kind });
          const geometry = [...figure.querySelectorAll("svg *")].flatMap(element => [...element.attributes].filter(attribute => ["x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "height", "width", "points"].includes(attribute.name)).map(attribute => attribute.value));
          if (geometry.some(value => /NaN|Infinity/.test(value))) throw new Error("Chart geometry is non-finite");
          if (figure.querySelectorAll("svg").length !== 1) throw new Error("Chart labels injected markup");
          checked++;
        }
      }
      return checked;
    });
    assert.equal(edgeCases, 8);
    const exactLargeValue = await page.evaluate(async () => {
      const { chartSeries } = await import("./result-data.mjs");
      const { renderResultChart } = await import("./result-chart.mjs");
      const series = chartSeries({ headers: ["Категория", "Число"], rows: [["A", "9007199254740993"]] }, 0, 1);
      const figure = renderResultChart(series);
      figure.querySelector("[role=button]").dispatchEvent(new Event("focus"));
      return figure.querySelector(".chart-value").textContent;
    });
    assert.equal(exactLargeValue, "9007199254740993", "readout preserves source digits beyond floating-point integer precision");

    await page.evaluate(() => {
      const text = ["## Большая таблица", "", "| Шаг | Значение |", "| --- | --- |", ...Array.from({ length: 501 }, (_, index) => `| Шаг ${index + 1} | ${index + 1} |`)].join("\n");
      localStorage.setItem("evomind.chats.v1", JSON.stringify([{ id: "large", title: "Большая таблица", turns: [{ id: "large-answer", question: "Большая таблица", steps: [], answer: { ok: true, text } }] }]));
    });
    await page.reload();
    await openFirst();
    assert.equal(await page.locator(".results-table tbody tr").count(), 500);
    assert.match(await page.locator("#results-table-note").innerText(), /500.*501/);
    await page.locator("#results-tab-chart").click();
    assert.equal(await page.locator("#results-chart [role=button]").count(), 60);
    assert.match(await page.locator("#results-chart-note").innerText(), /60 из 501/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "wide chart scrolls inside the result");
    const largeDownloadPromise = page.waitForEvent("download");
    await page.locator("#results-download").click();
    const largeCSV = await readFile(await (await largeDownloadPromise).path(), "utf8");
    assert.equal(largeCSV.trimEnd().split("\r\n").length, 502, "download includes the header and all 501 rows");
    assert.ok(largeCSV.endsWith('"Шаг 501","501"\r\n'));
    assert.deepEqual(errors, [], "results workspace has no uncaught browser errors");
  } catch (error) {
    await page.screenshot({ path: "test-results/results-failure.png", fullPage: true });
    throw error;
  } finally { await context.close(); }
}
