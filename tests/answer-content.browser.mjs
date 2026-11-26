// Called by the browser suite on an isolated page served by the local dev server.
export async function runRendererChecks(page, assert) {
  const result = await page.evaluate(async () => {
    const { renderMarkdown, renderCodeBlock } = await import("/answer-content.mjs");
    const markdown = [
      "## Проверка ответа",
      "",
      "Обычный текст с **важным**, *акцентом* и `x = 2`.",
      "Следующая строка: a² + b² = c².",
      "",
      "3. Первый шаг",
      "   - Вложенный пункт",
      "4. Второй шаг",
      "",
      "> Проверяем цитату.",
      "",
      "| Вход | Результат |",
      "| :--- | ---: |",
      "| `a | b` | **42** |",
      "| a\\|b | 43 |",
      "",
      "````python",
      "print('<script>alert(1)</script>')",
      "```",
      "````",
      "",
      "[Документация](https://example.com/docs?q=1&n=2)",
      "[Скобки](https://example.com/a_(b))",
    ].join("\n");
    const normal = renderMarkdown(markdown);
    const hostile = renderMarkdown([
      '<img src=x onerror="window.markdownExecuted = true">',
      '<script>window.markdownExecuted = true</script>',
      "[Опасная ссылка](javascript:alert(1))",
      "[Данные](data:text/html,hello)",
      "[Учётные данные](https://user:password@example.com)",
      "[Протокол](//example.com)",
      "![Изображение](https://example.com/tracker.png)",
      "<https://example.com/safe>",
      "_snake_case_stays_readable and **unfinished",
    ].join("\n\n"));
    document.body.append(normal, hostile);
    const answer = {
      headings: normal.querySelectorAll("h3").length,
      bold: normal.querySelector("strong")?.textContent,
      italic: normal.querySelector("em")?.textContent,
      inlineCode: normal.querySelector("p code")?.textContent,
      orderedStart: normal.querySelector("ol")?.start,
      nestedItem: normal.querySelector("ol > li > ul > li")?.textContent,
      quote: normal.querySelector("blockquote")?.textContent,
      rows: normal.querySelectorAll("tbody tr").length,
      cells: [...normal.querySelectorAll("tbody td")].map((cell) => cell.textContent),
      columnAlignment: normal.querySelectorAll("th")[1]?.dataset.align,
      language: normal.querySelector(".code-language")?.textContent,
      code: normal.querySelector(".code-content code")?.textContent,
      links: [...normal.querySelectorAll("a")].map((link) => ({ href: link.href, rel: link.rel, target: link.target })),
      formula: normal.textContent.includes("a² + b² = c²"),
      hostileElements: hostile.querySelectorAll("script, img, iframe, style, svg").length,
      hostileLinks: [...hostile.querySelectorAll("a")].map((link) => link.href),
      rawHtmlVisible: hostile.textContent.includes("<img src=x"),
      executed: Boolean(window.markdownExecuted),
      empty: renderMarkdown(null).textContent,
      unclosedFence: renderMarkdown("```js\nconst x = 1;").querySelector("code")?.textContent,
      invalidLanguage: renderCodeBlock("code", '<svg onload="alert(1)">').querySelector(".code-language")?.textContent,
    };
    normal.remove(); hostile.remove();
    return answer;
  });
  assert.equal(result.headings, 1);
  assert.equal(result.bold, "важным");
  assert.equal(result.italic, "акцентом");
  assert.equal(result.inlineCode, "x = 2");
  assert.equal(result.orderedStart, 3);
  assert.equal(result.nestedItem, "Вложенный пункт");
  assert.equal(result.quote, "Проверяем цитату.");
  assert.equal(result.rows, 2);
  assert.deepEqual(result.cells, ["a | b", "42", "a|b", "43"]);
  assert.equal(result.columnAlignment, "right");
  assert.equal(result.language, "python");
  assert.equal(result.code, "print('<script>alert(1)</script>')\n```");
  assert.equal(result.links.length, 2);
  assert.equal(result.links[1].href, "https://example.com/a_(b)");
  assert.ok(result.links.every((link) => link.rel === "noopener noreferrer" && link.target === "_blank"));
  assert.equal(result.formula, true);
  assert.equal(result.hostileElements, 0);
  assert.deepEqual(result.hostileLinks, ["https://example.com/safe"]);
  assert.equal(result.rawHtmlVisible, true);
  assert.equal(result.executed, false);
  assert.equal(result.empty, "");
  assert.equal(result.unclosedFence, "const x = 1;");
  assert.equal(result.invalidLanguage, "Код");

  // Exercise real browser click handling and both Clipboard API outcomes.
  await page.evaluate(async () => {
    const { renderCodeBlock } = await import("/answer-content.mjs");
    window.rendererClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    window.rendererCopied = null;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text) => { window.rendererCopied = text; } },
    });
    const host = document.createElement("div");
    host.id = "renderer-copy-fixture";
    host.append(renderCodeBlock("print(42)", "python"));
    document.body.append(host);
  });
  const copy = page.locator("#renderer-copy-fixture .code-copy");
  await copy.click();
  assert.equal(await page.evaluate(() => window.rendererCopied), "print(42)");
  assert.equal(await copy.getAttribute("data-copy-state"), "copied");
  assert.equal(await copy.textContent(), "Скопировано");
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async () => { throw new Error("Clipboard denied"); } },
    });
  });
  await copy.click();
  assert.equal(await copy.getAttribute("data-copy-state"), "error");
  assert.equal(await copy.textContent(), "Не удалось скопировать");
  await page.evaluate(() => {
    if (window.rendererClipboardDescriptor) Object.defineProperty(navigator, "clipboard", window.rendererClipboardDescriptor);
    else delete navigator.clipboard;
    delete window.rendererClipboardDescriptor;
    delete window.rendererCopied;
    document.getElementById("renderer-copy-fixture").remove();
  });
}
