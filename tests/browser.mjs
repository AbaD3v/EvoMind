import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { serve } from '../scripts/serve.mjs';
import { runRendererChecks } from './answer-content.browser.mjs';
import { runRecoveryChecks } from './recovery.browser.mjs';
import { runResultsChecks } from './results.browser.mjs';

// Fixtures replace only the Gradio transport. The production DOM, modules,
// event handling, storage and CSS run unchanged in an isolated browser.
const mockClient = `
const answer = '## Разберём по шагам\\n\\nМодель использует **проверенные примеры**, чтобы улучшать ответы.\\n\\n1. Собираем данные.\\n2. Проверяем качество.\\n3. Сравниваем результат на отдельном тестовом наборе.\\n\\n| Этап | Что проверяем |\\n| --- | --- |\\n| До обучения | Исходное качество |\\n| После обучения | Изменение качества |\\n\\n\\x60\\x60\\x60python\\nfor example in verified_examples:\\n    train_step(example)\\n\\x60\\x60\\x60\\n\\n> Сохранение истории чата само по себе не обучает модель.';
export const Client = { connect: async () => ({
  config: {dependencies:[{api_name:'respond_events'},{api_name:'respond_events_budgeted'}]},
  predict: async () => {
    window.mockLibraryCalls = (window.mockLibraryCalls || 0) + 1;
    if (window.libraryMode === 'error') throw new Error('Failed to fetch secret-internal-value');
    if (window.libraryMode === 'malformed') return {data:[{}]};
    if (window.libraryMode === 'empty') return {data:[[]]};
    if (window.libraryMode === 'slow') await new Promise(r=>setTimeout(r,250));
    return {data:[[
      {tool_id:'rectangle_perimeter',version:2,name:'Периметр прямоугольника',description:'Вычисляет периметр по длине и ширине. Подходит для геометрических задач.'},
      {tool_id:'gcd',version:1,name:'Общий делитель',description:'Находит наибольший общий делитель двух целых чисел.'},
      {tool_id:'safe',version:1,name:'<img src=x onerror=alert(1)>',description:'Текст инструмента не исполняется как HTML.'}
    ]]};
  },
  submit: () => {
    window.mockSubmissions = (window.mockSubmissions || 0) + 1;
    const mode = window.replyMode;
    let end;
    const waiting = new Promise(resolve=>end=resolve);
    return {
      cancel: () => { window.mockCancellations = (window.mockCancellations || 0) + 1; end(); },
      async *[Symbol.asyncIterator]() {
        yield {type:'status',stage:'pending',position:1};
        if (mode === 'slow') { await waiting; return; }
        if (mode === 'network') { yield {type:'status',stage:'error',message:'Failed to fetch secret-internal-value'}; return; }
        if (mode === 'quota') { yield {type:'status',stage:'error',message:'GPU quota exceeded: 120s requested vs. 0s left'}; return; }
        if (mode === 'sleeping') { yield {type:'status',stage:'error',message:'Space sleeping'}; return; }
        if (mode === 'malformed') { yield {type:'data',data:['{broken']}; return; }
        if (mode === 'empty') { yield {type:'data',data:[{type:'answer',ok:true,text:''}]}; return; }
        yield {type:'data',data:[{type:'step',id:'thinking',title:'Анализирую задачу',phase:'thinking',streams_text:true,status:'running',details:[]}]};
        yield {type:'data',data:[{type:'thinking',id:'thinking',delta:'Проверяю условие и выбираю способ решения.'}]};
        yield {type:'data',data:[{type:'step',id:'thinking',title:'Анализ завершён',phase:'thinking',streams_text:true,status:'success',details:[]}]};
        yield {type:'data',data:[{type:'answer',ok:true,text:answer}]};
      }
    };
  }
}) };
`;

const server = serve(0);
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch(process.env.PLAYWRIGHT_EXECUTABLE_PATH
  ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH, headless: true }
  : { channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const errors = [];
await context.route('**/*', (route) => {
  const url = route.request().url();
  if (url.startsWith(base)) return route.continue();
  if (url.startsWith('https://cdn.jsdelivr.net/npm/@gradio/client@')) return route.fulfill({ contentType: 'text/javascript', body: mockClient });
  return route.abort();
});
context.on('page', (page) => {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
});
const page = await context.newPage();
page.setDefaultTimeout(8000);
await mkdir('test-results', { recursive: true });
async function load() {
  await page.goto(base);
  await page.waitForFunction(() => !document.querySelector('#hf-account').disabled);
}
async function send(message, mode) {
  await page.evaluate((value) => { window.replyMode = value; }, mode);
  await page.locator('#question').fill(message);
  await page.locator('#send').click();
}
async function settled() {
  await page.waitForFunction(() => document.querySelector('#stop-generation').hidden);
}
async function fits(width) {
  await page.setViewportSize({ width, height: 1000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
  assert.equal(overflow, false, `page overflows at ${width}px`);
}
try {
  await load();
  assert.equal(await page.locator('#empty').isVisible(), true);
  await page.screenshot({ path: 'test-results/welcome-desktop.png' });
  for (const width of [320, 768, 1024, 1440]) await fits(width);
  await send('Объясни, как улучшать модель на проверенных примерах.', 'success');
  await settled();
  assert.equal(await page.locator('.answer-markdown h3').count(), 1);
  assert.equal(await page.locator('.markdown-table tbody tr').count(), 2);
  assert.equal(await page.locator('.code-block').count(), 1);
  assert.match(await page.locator('.answer-markdown').innerText(), /проверенные примеры/);
  await page.locator('.work > summary').click();
  assert.match(await page.locator('.thinking-transcript').innerText(), /Проверяю условие/);
  await page.locator('.work > summary').click();
  await page.screenshot({ path: 'test-results/answer-desktop.png' });
  for (const width of [320, 768, 1024, 1440]) await fits(width);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/answer-mobile.png' });
  await page.locator('#sidebar-toggle').click();
  assert.equal(await page.locator('.workspace').evaluate((el) => el.inert), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.workspace').evaluate((el) => el.inert), false);
  assert.equal(await page.locator('#sidebar-toggle').evaluate((el) => el === document.activeElement), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await load();
  assert.equal(await page.locator('.markdown-table').count(), 1, 'history is rendered after reload');

  await send('Проверь соединение', 'network');
  await settled();
  assert.match(await page.locator('.error-title').last().innerText(), /Соединение/);
  assert.equal((await page.locator('body').innerText()).includes('secret-internal-value'), false);
  await page.screenshot({ path: 'test-results/error-desktop.png' });
  await page.evaluate(() => { window.replyMode = 'success'; });
  await page.locator('.retry-answer').last().click();
  await settled();
  assert.equal(await page.locator('.answer-markdown h3').count(), 2, 'retry completes without losing prior turns');
  for (const [mode, title] of [['quota', 'квоты GPU'], ['sleeping', 'временно недоступен'], ['malformed', 'прочитать ответ'], ['empty', 'прочитать ответ']]) {
    await send(`Проверка: ${mode}`, mode);
    await settled();
    assert.ok((await page.locator('.error-title').last().innerText()).includes(title));
  }
  await send('Долгая задача', 'slow');
  await page.waitForFunction(() => document.querySelector('.turn:last-child .turn-status').dataset.state === 'waiting');
  await page.locator('#stop-generation').click();
  await settled();
  assert.match(await page.locator('.error-title').last().innerText(), /остановлен/);
  assert.equal(await page.locator('.turn:last-child .retry-answer').count(), 0);
  assert.ok(await page.evaluate(() => window.mockCancellations > 0));
  await context.setOffline(true);
  await page.waitForFunction(() => !document.querySelector('#connection-banner').hidden);
  await page.locator('#question').fill('Черновик без интернета');
  assert.equal(await page.locator('#send').isDisabled(), true);
  await context.setOffline(false);
  await page.waitForFunction(() => !document.querySelector('#send').disabled);
  assert.equal(await page.locator('#question').inputValue(), 'Черновик без интернета');

  await page.locator('#open-library').click();
  await page.waitForFunction(() => document.querySelectorAll('.library-card').length === 3);
  assert.equal(await page.locator('#library img').count(), 0);
  await page.locator('#library-search').fill('периметр');
  assert.equal(await page.locator('.library-card').count(), 1);
  await page.locator('.tool-heading').click();
  assert.match(await page.locator('.tool-meta').innerText(), /rectangle_perimeter/);
  await page.screenshot({ path: 'test-results/tools-desktop.png' });
  for (const width of [320, 768, 1024, 1440]) await fits(width);
  const submissions = await page.evaluate(() => window.mockSubmissions);
  await page.getByRole('button', { name: 'Показать код', exact: true }).click();
  assert.match(await page.locator('#question').inputValue(), /rectangle_perimeter/);
  assert.equal(await page.evaluate(() => window.mockSubmissions), submissions, 'tool action only prepares a prompt');
  assert.equal(await page.locator('#question').evaluate((el) => el === document.activeElement), true);
  await page.locator('#open-library').click();
  await page.waitForFunction(() => document.querySelectorAll('.library-card').length > 0);
  await page.locator('#library-search').fill('ничего-такого');
  assert.match(await page.locator('#library-state').innerText(), /Ничего не найдено/);
  await page.evaluate(() => { window.libraryMode = 'error'; });
  await page.locator('#library-refresh').click();
  await page.waitForFunction(() => document.querySelector('#library').getAttribute('aria-busy') === 'false');
  assert.match(await page.locator('#library-state').innerText(), /Соединение/);
  await page.evaluate(() => { window.libraryMode = 'empty'; });
  await page.getByRole('button', { name: 'Повторить загрузку' }).click();
  await page.waitForFunction(() => document.querySelector('#library').getAttribute('aria-busy') === 'false');
  assert.match(await page.locator('#library-state').innerText(), /пока нет инструментов/);
  await page.keyboard.press('Escape');

  const rendererPage = await context.newPage();
  await rendererPage.goto(base + '/tests/blank.html');
  await runRendererChecks(rendererPage, assert);
  await rendererPage.close();
  await runRecoveryChecks(browser, base, assert);
  await runResultsChecks(browser, base, assert);
  assert.deepEqual(errors, [], 'no browser errors');
  console.log('Browser checks passed: responsive layouts, history, rich answers, safe markup, retry, cancellation, offline draft, tools, keyboard focus, result tables/charts/CSV.');
} catch (error) {
  console.error('Browser errors:', errors);
  console.error('Library state:', await page.locator('#library').innerText());
  await page.screenshot({ path: 'test-results/failure.png', fullPage: true });
  throw error;
} finally {
  await browser.close();
  server.close();
}
