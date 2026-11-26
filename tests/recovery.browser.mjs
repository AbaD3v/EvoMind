const transport = `
const tool = (id, name) => ({tool_id:id,name,description:'Проверочный инструмент',version:1});
export const Client = { connect: async () => {
  window.recoveryConnects = (window.recoveryConnects || 0) + 1;
  if (window.recoveryScenario === 'timeout' && window.recoveryConnects === 1) await new Promise(() => {});
  return {
    config:{dependencies:[{api_name:'respond_events'}]},
    predict: async () => {
      window.recoveryPredictions = (window.recoveryPredictions || 0) + 1;
      if (window.recoveryScenario === 'race') {
        if (window.recoveryPredictions === 1) return new Promise(resolve => {
          window.releaseOldLibrary = () => resolve({data:[[tool('old','Устаревший результат')]]});
        });
        return {data:[[tool('new','Актуальный результат')]]};
      }
      return {data:[[]]};
    },
    submit: () => {
      let finish;
      const wait = new Promise(resolve => finish = resolve);
      return {
        cancel: () => { window.recoveryCancelled = true; finish(); },
        async *[Symbol.asyncIterator]() {
          yield {type:'status',stage:'pending'};
          if (window.recoveryScenario === 'auth') {
            yield {type:'data',data:[{type:'answer',ok:false,text:'401 Unauthorized'}]};
          } else {
            await wait;
          }
        }
      };
    }
  };
}};
`;

export async function runRecoveryChecks(browser, base, assert) {
  async function fixture(scenario, { authenticated = false } = {}) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
    const errors = [];
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(base + '/')) return route.continue();
      if (url.startsWith('https://cdn.jsdelivr.net/npm/@gradio/client@')) return route.fulfill({ contentType: 'text/javascript', body: transport });
      return route.abort();
    });
    await context.addInitScript(({ scenario, authenticated }) => {
      window.recoveryScenario = scenario;
      if (authenticated) sessionStorage.setItem('evomind.hf.session', JSON.stringify({
        token: 'synthetic-test-token-not-a-real-credential', username: 'test-account', expiresAt: Date.now() + 60_000,
      }));
    }, { scenario, authenticated });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(base);
    await page.waitForFunction(() => !document.querySelector('#hf-account').disabled);
    return { page, context, errors };
  }

  const auth = await fixture('auth', { authenticated: true });
  try {
    assert.equal(await auth.page.locator('#hf-account-label').textContent(), '@test-account');
    await auth.page.locator('#question').fill('Проверка истёкшей сессии');
    await auth.page.locator('#send').click();
    await auth.page.waitForFunction(() => document.querySelector('#stop-generation').hidden);
    assert.equal(await auth.page.locator('#hf-account-label').textContent(), 'Войти через HF');
    assert.match(await auth.page.locator('.error-title').innerText(), /войти в Hugging Face/);
    assert.equal(await auth.page.evaluate(() => sessionStorage.getItem('evomind.hf.session')), null);
    assert.deepEqual(auth.errors, []);
  } finally { await auth.context.close(); }

  const timeout = await fixture('timeout');
  try {
    await timeout.page.clock.install();
    await timeout.page.locator('#open-library').click();
    await timeout.page.waitForFunction(() => window.recoveryConnects === 1);
    await timeout.page.clock.fastForward(30_100);
    await timeout.page.waitForFunction(() => document.querySelector('#library').getAttribute('aria-busy') === 'false');
    assert.match(await timeout.page.locator('#library-state').innerText(), /не пришёл вовремя/);
    await timeout.page.getByRole('button', { name: 'Повторить загрузку' }).click();
    await timeout.page.waitForFunction(() => window.recoveryConnects === 2 && document.querySelector('#library').getAttribute('aria-busy') === 'false');
    assert.equal(await timeout.page.evaluate(() => window.recoveryPredictions), 1);
    assert.match(await timeout.page.locator('#library-state').innerText(), /пока нет инструментов/);
    assert.deepEqual(timeout.errors, []);
  } finally { await timeout.context.close(); }

  const race = await fixture('race');
  try {
    await race.page.locator('#open-library').click();
    await race.page.waitForFunction(() => typeof window.releaseOldLibrary === 'function');
    await race.page.keyboard.press('Escape');
    await race.page.waitForFunction(() => !document.querySelector('#library').open);
    await race.page.locator('#open-library').click();
    await race.page.waitForFunction(() => document.querySelector('.tool-name')?.textContent === 'Актуальный результат');
    await race.page.evaluate(async () => { window.releaseOldLibrary(); await Promise.resolve(); });
    // Cross a browser task boundary so the obsolete promise's continuation runs.
    await race.page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(await race.page.locator('.tool-name').innerText(), 'Актуальный результат');
    assert.equal(await race.page.locator('.library-card').count(), 1);
    assert.equal(await race.page.locator('#library').getAttribute('aria-busy'), 'false');
    assert.deepEqual(race.errors, []);
  } finally { await race.context.close(); }

  const switching = await fixture('switch');
  try {
    const original = 'Исходная долгая задача';
    await switching.page.locator('#question').fill(original);
    await switching.page.locator('#send').click();
    await switching.page.waitForFunction(() => document.querySelector('.turn-status').dataset.state === 'waiting');
    await switching.page.locator('#new-chat').click();
    assert.equal(await switching.page.locator('#empty').isVisible(), true);
    await switching.page.locator('#question').fill('Черновик нового чата');
    await switching.page.locator('#stop-generation').click();
    await switching.page.waitForFunction(() => document.querySelector('#stop-generation').hidden);
    assert.equal(await switching.page.locator('#question').inputValue(), 'Черновик нового чата');
    assert.equal(await switching.page.locator('#empty').isVisible(), true);
    const saved = await switching.page.evaluate(() => JSON.parse(localStorage.getItem('evomind.chats.v1')));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].turns.length, 1);
    assert.equal(saved[0].turns[0].question, original);
    assert.equal(saved[0].turns[0].answer.cancelled, true);
    await switching.page.locator('.history-entry').filter({ hasText: original }).click();
    assert.equal(await switching.page.locator('.question').textContent(), original);
    assert.match(await switching.page.locator('.error-title').innerText(), /остановлен/);
    assert.equal(await switching.page.evaluate(() => window.recoveryCancelled), true);
    assert.deepEqual(switching.errors, []);
  } finally { await switching.context.close(); }
}
