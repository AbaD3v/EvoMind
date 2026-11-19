import { completeHfLogin, readHfSession, signOutFromHf, startHfLogin } from "./hf-auth.mjs";
import { renderHtmlCard } from "./card-preview.mjs";
import { readQuotaError, streamSpaceEvents } from "./space-events.mjs";

const CLIENT_MODULE = "https://cdn.jsdelivr.net/npm/@gradio/client@2.8.0/dist/index.min.js";
const SPACE = document.querySelector('meta[name="evomind-space"]').content;
const SPACE_PAGE = "https://huggingface.co/spaces/AbaD3v/MoonAI-8B_qlora_Qwen3";
const STORAGE_KEY = "evomind.chats.v1";
const TURN_STATUS = {
  connecting: "Готовлюсь к запуску…",
  waiting: "Жду запуска…",
  thinking: "Думаю над задачей…",
  solving: "Решаю задачу…",
  tools: "Работаю с инструментами…",
  ready: "Ответ готов",
  error: "Не удалось завершить запрос",
};
const byId = (id) => document.getElementById(id);
const thread = byId("thread");
const conversation = byId("conversation");
const question = byId("question");
const composer = byId("composer");
const send = byId("send");
const jump = byId("jump-latest");
const chatMenu = byId("chat-menu");
const hfButton = byId("hf-account");
const hfDialog = byId("hf-account-dialog");
const hfLogout = byId("hf-logout");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const seconds = new Intl.NumberFormat("ru", { maximumFractionDigits: 1 });
const views = new Map();

let chats = readChats();
let active = chats[0] ?? newChat();
let processing = null;
let connection;
let hfSession = readHfSession();
let hfLoading = true;

function readChats() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]").map((chat) => ({
      ...chat,
      turns: chat.turns.map((turn) => turn.answer ? turn : {
        ...turn,
        steps: turn.steps.map((step) => step.status === "running" ? interruptedStep(step) : step),
        answer: { text: "Запрос прервался при закрытии страницы.", ok: false },
      }),
    }));
  } catch {
    return [];
  }
}

function saveChats() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
  } catch (error) {
    console.warn("EvoMind: не удалось сохранить историю.", error);
  }
}

function newChat() {
  return { id: crypto.randomUUID(), title: "Новый чат", turns: [] };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function lightIcon(name) {
  const icon = element("span", "icon");
  icon.dataset.icon = name;
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

function isThinking(step) {
  return step.phase === "thinking" || step.streams_text === true ||
    ["Анализирую задачу", "Анализ задачи завершён", "Анализ задачи прерван", "Проанализировал задачу"].includes(step.title);
}

function interruptedStep(step) {
  let title = "Шаг прерван";
  if (step.phase === "route") title = "Разбор запроса прерван";
  if (isThinking(step)) title = "Анализ задачи прерван";
  if (step.group) title = "Создание инструмента прервано";
  return { ...step, status: "error", title };
}

function measureThinking(step, previous = step) {
  if (!isThinking(step)) return;
  if (step.status === "running") {
    step.startedAt = previous?.startedAt ?? performance.now();
  } else if (previous?.startedAt !== undefined) {
    step.elapsedMs = performance.now() - previous.startedAt;
  } else if (previous?.elapsedMs !== undefined) {
    step.elapsedMs = previous.elapsedMs;
  }
}

function buildThinkingHeading(heading) {
  const emblem = heading.querySelector(".step-symbol");
  emblem.className = "thinking-emblem";
  const result = lightIcon("check");
  result.classList.add("thinking-result");
  emblem.replaceChildren(element("span", "brand-mark"), result);
  const dots = element("span", "thinking-dots");
  dots.setAttribute("aria-hidden", "true");
  dots.append(element("span"), element("span"), element("span"));
  heading.querySelector(".step-title").setAttribute("aria-live", "polite");
  heading.append(dots, element("span", "thinking-time"));
}

function renderThinkingText(row, step) {
  const transcript = row?.querySelector(".thinking-transcript");
  if (!transcript) return;
  const follow = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 24;
  transcript.textContent = step.thinkingText || (step.status === "running" ? "Ожидаю текст анализа…" : "Текст анализа недоступен.");
  if (follow) transcript.scrollTop = transcript.scrollHeight;
}

function renderHistory() {
  const history = byId("history");
  const query = byId("search").value.trim().toLocaleLowerCase("ru");
  const visible = chats.filter((chat) => chat.title.toLocaleLowerCase("ru").includes(query));
  history.replaceChildren();
  for (const chat of visible) {
    const button = element("button", "history-entry");
    button.append(lightIcon("chat_bubble"), element("span", "history-label", chat.title));
    button.type = "button";
    button.title = chat.title;
    button.setAttribute("aria-current", String(chat === active));
    button.onclick = () => selectChat(chat);
    history.append(button);
  }
  if (!visible.length) {
    history.append(element("p", "history-empty", query ? "Ничего не найдено" : "Здесь появятся твои чаты"));
  }
}

function updateTitle() {
  const title = byId("chat-title");
  title.textContent = title.title = active.title;
  chatMenu.hidden = !active.turns.length;
  byId("empty").hidden = active.turns.length > 0;
  thread.hidden = !active.turns.length;
}

function shouldOpenWork(turn) {
  return turn.workOpen ?? Object.values(turn.openSteps ?? {}).some(Boolean);
}

function renderTurnStatus(turn) {
  const { status, statusIcon, statusLabel } = views.get(turn.id);
  const state = turn.answer ? (turn.answer.ok ? "ready" : "error") : turn.progress?.state ?? "connecting";
  const label = (turn.answer ? null : turn.progress?.label) ?? TURN_STATUS[state];
  if (statusLabel.textContent !== label) statusLabel.textContent = label;
  status.dataset.state = state;
  statusIcon.dataset.icon = state === "error" ? "close" : "check";
}

function setTurnProgress(turn, state, label) {
  if (turn.progress?.state === state && turn.progress.label === label) return;
  turn.progress = { state, label };
  if (views.has(turn.id)) renderTurnStatus(turn);
}

function updateTurnProgress(turn, step) {
  if (isThinking(step)) {
    setTurnProgress(turn, step.status === "running" ? "thinking" : "solving");
  } else if (step.phase === "route" || step.title === "Разбираю запрос." || step.title === "Перевожу условие в формулу") {
    setTurnProgress(turn, "thinking");
  } else if (step.phase === "web" || step.group || step.parent_id != null ||
    /^(Ищу инструменты|Поиск инструментов|Подбираю схему|Сверяю постановку|Запускаю |Составляю план цепочки)/u.test(step.title)) {
    setTurnProgress(turn, "tools");
  } else if (turn.progress?.state !== "tools") {
    setTurnProgress(turn, "solving");
  }
}

function makeTurn(turn) {
  const row = element("article", "turn");
  const bubble = element("p", "bubble question", turn.question);
  const assistant = element("div", "assistant");
  assistant.setAttribute("role", "group");
  assistant.setAttribute("aria-label", "Ответ EvoMind");
  const avatar = element("span", "assistant-avatar");
  avatar.setAttribute("aria-hidden", "true");
  avatar.append(element("span", "brand-mark"));
  const stack = element("div", "assistant-stack");
  const status = element("p", "turn-status");
  status.setAttribute("role", "status");
  const statusIcon = lightIcon("check");
  const statusLabel = element("span");
  status.append(statusIcon, statusLabel);
  const panel = element("div", "assistant-panel");
  const work = element("details", "work");
  const heading = element("summary");
  const count = element("span", "work-count");
  count.title = "Количество шагов";
  heading.append(lightIcon("timeline"), element("span", "work-title", "Ход работы"), count, lightIcon("chevron_right"));
  const steps = element("div", "steps");
  work.append(heading, steps);
  work.open = shouldOpenWork(turn);
  work.ontoggle = () => {
    if (shouldOpenWork(turn) === work.open) return;
    turn.workOpen = work.open;
    if (views.has(turn.id)) saveChats();
  };
  const reply = element("div", "reply");
  const actions = element("div", "reply-actions");
  panel.hidden = work.hidden = reply.hidden = actions.hidden = true;
  panel.append(reply, actions, work);
  stack.append(status, panel);
  assistant.append(avatar, stack);
  row.append(bubble, assistant);
  const view = { row, assistant, status, statusIcon, statusLabel, panel, work, count, steps, reply, actions, stepRows: new Map() };
  views.set(turn.id, view);
  for (const step of turn.steps) renderStep(turn, step);
  if (turn.answer) renderAnswer(turn);
  else renderTurnStatus(turn);
  return row;
}

function renderStep(turn, step) {
  const view = views.get(turn.id);
  let row = view.stepRows.get(step.id);
  const previousStatus = row?.dataset.status;
  const isGroup = step.group === true;
  const thinking = row ? row.classList.contains("thinking-step") : isThinking(step);
  const streamsThinking = thinking && step.streams_text === true;
  const defaultOpen = isGroup || streamsThinking;
  const expandable = defaultOpen || step.details.length > 0 ||
    (step.status === "running" && !thinking && step.phase !== "route");
  if (!row) {
    row = element(expandable ? "details" : "div", isGroup ? "step step-group" : "step");
    const heading = element(expandable ? "summary" : "div", "step-heading");
    const symbol = element("span", "step-symbol");
    symbol.setAttribute("aria-hidden", "true");
    symbol.append(lightIcon("more_horiz"));
    heading.append(symbol, element("span", "step-title"));
    if (thinking) {
      row.classList.add("thinking-step");
      buildThinkingHeading(heading);
    }
    const content = element("div", "step-content");
    row.append(heading, content);
    if (streamsThinking) {
      content.classList.add("thinking-content");
      const transcript = element("div", "thinking-transcript");
      transcript.tabIndex = 0;
      transcript.setAttribute("role", "region");
      transcript.setAttribute("aria-label", "Текст анализа Qwen");
      content.append(transcript);
    }
    if (isGroup) {
      heading.append(element("span", "substep-count"));
      row.append(element("div", "step-children"));
    }
    if (expandable) {
      heading.append(lightIcon("chevron_right"));
      row.open = turn.openSteps?.[step.id] ?? defaultOpen;
      row.ontoggle = () => {
        if ((turn.openSteps?.[step.id] ?? defaultOpen) === row.open) return;
        turn.openSteps ??= {};
        turn.openSteps[step.id] = row.open;
        if (views.has(turn.id)) saveChats();
      };
    }
    view.stepRows.set(step.id, row);
    const parent = view.stepRows.get(step.parent_id);
    const children = parent?.querySelector(":scope > .step-children");
    (children ?? view.steps).append(row);
    if (children) {
      const count = parent.querySelector(":scope > summary .substep-count");
      count.textContent = String(children.childElementCount);
      count.title = "Вложенные шаги";
    }
  }
  row.dataset.status = step.status;
  row.classList.toggle("step-updated", view.row.isConnected && previousStatus !== step.status);
  const heading = row.firstElementChild;
  const statusIcon = { error: "close", success: "check" }[step.status] ?? "more_horiz";
  heading.querySelector(thinking ? ".thinking-result" : ".step-symbol > .icon").dataset.icon = statusIcon;
  heading.querySelector(".step-title").textContent = thinking && step.status === "error" ? "Анализ задачи прерван" : step.title;
  if (thinking) {
    heading.querySelector(".thinking-time").textContent =
      Number.isFinite(step.elapsedMs) ? `${seconds.format(step.elapsedMs / 1000)} с` : "";
  }
  view.panel.hidden = view.work.hidden = false;
  view.count.textContent = String(turn.steps.length);
  if (streamsThinking) {
    renderThinkingText(row, step);
    return;
  }
  const content = row.querySelector(":scope > .step-content");
  const details = step.details.map(({ label, text, code }) => {
    const block = element("div", "step-detail");
    if (step.status === "error" && ["Вход", "Ожидалось", "Получено"].includes(label)) {
      block.classList.add("check-value");
    }
    const value = code ? element("pre") : element("p", "", text);
    if (code) value.append(element("code", "", text));
    block.append(element("h3", "", label), value);
    return block;
  });
  if (!details.length && !isGroup && row.tagName === "DETAILS") {
    details.push(element("p", "waiting-detail", step.status === "running"
      ? "Ожидаю результат шага…" : "Подробности об этом шаге недоступны."));
  }
  content.replaceChildren(...details);
  content.hidden = !details.length;
}

function readResult(text) {
  const formula = /^Формула — (.+)\nРезультат — (.+)\.$/u.exec(text);
  if (formula) return { value: formula[2], input: formula[1], inputLabel: "Формула", code: false };

  const tool = /^Вход инструмента — (\{.*\})\. Результат — (.+)\.$/u.exec(text);
  if (!tool) return null;
  try {
    JSON.parse(tool[1]);
    const value = JSON.parse(tool[2]);
    return {
      value: typeof value === "string" && value !== "" ? value : tool[2],
      input: tool[1],
      inputLabel: "Вход инструмента",
      code: value !== null && typeof value === "object",
    };
  } catch {
    return null;
  }
}

function renderResult({ value, input, inputLabel, code }) {
  const result = element("dl", "answer-readout");
  const main = element("div", "answer-main");
  const valueNode = element("dd", "answer-value", code ? undefined : value);
  if (code) {
    const pre = element("pre");
    pre.append(element("code", "", value));
    valueNode.append(pre);
  } else if (value.length <= 24 && !value.includes("\n")) {
    valueNode.classList.add("answer-emphasis");
  }
  main.append(element("dt", "answer-label", "Результат"), valueNode);
  const evidence = element("div", "answer-evidence");
  const inputNode = element("dd");
  inputNode.append(element("code", "", input));
  evidence.append(element("dt", "answer-label", inputLabel), inputNode);
  result.append(main, evidence);
  return result;
}

function renderPresentation({ lead, explanation, tool_note: toolNote }) {
  const block = element("div", "answer-presentation");
  block.append(element("p", "answer-lead", lead));
  if (explanation) block.append(element("p", "answer-explanation", explanation));
  if (toolNote) block.append(element("p", "answer-tool-note", toolNote));
  return block;
}

function webLink(item, className, label) {
  if (typeof item?.url !== "string") return null;
  try {
    const url = new URL(item.url);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const link = element("a", className, label);
    link.href = url.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  } catch {
    return null;
  }
}

function renderWebResult(result) {
  if (result?.type === "web_search" && Array.isArray(result.results)) {
    const sources = element("ul", "web-sources");
    for (const item of result.results.slice(0, 6)) {
      const link = webLink(item, "web-source-title", item?.title);
      if (!link) continue;
      const source = element("li", "web-source");
      source.append(link, element("p", "web-domain", new URL(link.href).hostname));
      if (item.description) source.append(element("p", "web-description", item.description));
      sources.append(source);
    }
    return sources.childElementCount ? sources : null;
  }
  if (result?.type === "html_card") {
    const link = webLink(result, "small-button preview-link", "Открыть источник");
    return link ? renderHtmlCard(result, link) : null;
  }
  const isPreview = result?.type === "site_preview";
  if (!isPreview && result?.type !== "web_page") return null;
  const link = webLink(result, "small-button preview-link", "Открыть сайт");
  if (!link) return null;
  const preview = element("article", isPreview ? "site-preview" : "web-page");
  if (isPreview) {
    preview.dataset.layout = result.layout === "compact" ? "compact" : "wide";
    preview.dataset.accent = ["blue", "green", "red", "purple"].includes(result.accent) ? result.accent : "neutral";
  }
  preview.append(element("p", "web-domain", new URL(link.href).hostname), element("h3", "", result.title));
  if (result.description && result.show_description !== false) {
    preview.append(element("p", "web-description", result.description));
  }
  const excerpt = result.type === "web_page" ? result.text : result.show_excerpt ? result.excerpt : "";
  if (excerpt) preview.append(element("p", "web-excerpt", excerpt));
  preview.append(link);
  return preview;
}

function renderAnswer(turn) {
  const { assistant, status, panel, reply, actions, work } = views.get(turn.id);
  const { text, ok, presentation, guestQuota, webResult } = turn.answer;
  const fencedCode = /\n{2}````python\n([\s\S]*?)\n````\s*$/;
  const match = text.match(fencedCode);
  const prefix = match ? text.slice(0, match.index).trimEnd() : text;
  const sourceLabel = "\n\nКод инструмента";
  const sourceNamed = match && prefix.endsWith(sourceLabel);
  const body = sourceNamed ? prefix.slice(0, -sourceLabel.length) : prefix;
  const result = ok && !presentation ? readResult(body) : null;
  const answerBody = presentation ? renderPresentation(presentation)
    : result ? renderResult(result) : element("div", "", body);
  reply.replaceChildren(answerBody);
  const webView = renderWebResult(webResult);
  if (webView && webResult.type === "web_search") {
    const note = answerBody.querySelector(".answer-tool-note");
    reply.append(webView);
    if (note) reply.append(note);
  } else if (webView) {
    reply.replaceChildren(webView);
    if (presentation?.tool_note) reply.append(element("p", "answer-tool-note", presentation.tool_note));
  }
  if (match) {
    const pre = element("pre");
    pre.append(element("code", "", match[1]));
    const source = element("div", "answer-source");
    if (sourceNamed) source.append(element("p", "answer-label", "Код инструмента"));
    source.append(pre);
    reply.append(source);
  }
  if (guestQuota) {
    const links = element("div", "quota-actions");
    if (!hfSession) {
      const login = element("button", "small-button account-button", "Войти через HF");
      login.type = "button";
      login.onclick = beginHfLogin;
      links.append(login);
    }
    const link = element("a", "quota-link", "Открыть Space в Hugging Face");
    link.href = SPACE_PAGE;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    links.append(link);
    reply.append(links);
  }
  reply.dataset.ok = String(ok);
  assistant.dataset.complete = "true";
  if (!work.contains(document.activeElement)) work.open = shouldOpenWork(turn);
  panel.hidden = reply.hidden = false;
  renderTurnStatus(turn);
  if (reply.isConnected) {
    reply.classList.add("message-enter");
    if (ok) status.classList.add("turn-status-arrived");
  }

  const copy = element("button", "copy");
  copy.type = "button";
  const label = element("span", "", "Копировать");
  label.setAttribute("aria-live", "polite");
  const copyIcon = lightIcon("content_copy");
  copy.append(copyIcon, label);
  let copyTimer;
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.dataset.copyState = "copied";
      copyIcon.dataset.icon = "check";
      label.textContent = "Скопировано";
    } catch {
      copy.dataset.copyState = "error";
      copyIcon.dataset.icon = "close";
      label.textContent = "Копирование недоступно";
    }
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      delete copy.dataset.copyState;
      copyIcon.dataset.icon = "content_copy";
      label.textContent = "Копировать";
    }, 1800);
  };
  actions.replaceChildren(copy);
  actions.hidden = false;
}

function setSidebar(open) {
  byId("sidebar").classList.toggle("open", open);
  byId("sidebar-toggle").setAttribute("aria-expanded", String(open));
}

function selectChat(chat) {
  active = chat;
  views.clear();
  thread.replaceChildren(...chat.turns.map(makeTurn));
  updateTitle();
  renderHistory();
  setSidebar(false);
  chatMenu.open = false;
  conversation.scrollTop = conversation.scrollHeight;
  syncJump();
}

function distanceToLatest() {
  return conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight;
}

function syncJump() {
  jump.hidden = distanceToLatest() < 160;
}

function scrollWithUpdate(update, force = false) {
  const follow = force || distanceToLatest() < 90;
  update();
  if (follow) conversation.scrollTop = conversation.scrollHeight;
  syncJump();
}

function showLatestAnswer(turn) {
  const follow = distanceToLatest() < 90;
  renderAnswer(turn);
  if (follow) {
    const { status } = views.get(turn.id);
    const statusTop = status.getBoundingClientRect().top - conversation.getBoundingClientRect().top;
    conversation.scrollTop = Math.min(conversation.scrollHeight - conversation.clientHeight,
      conversation.scrollTop + statusTop - 16);
  }
  syncJump();
}

function syncComposer() {
  send.disabled = hfLoading || Boolean(processing) || !question.value.trim();
  composer.dataset.busy = String(Boolean(processing));
}

function connect(token) {
  if (connection && connection.token === token) return connection.promise;
  const promise = import(CLIENT_MODULE).then(({ Client }) => Client.connect(SPACE, {
    events: ["data", "status"], token,
  }));
  connection = { token, promise };
  promise.catch(() => {
    if (connection?.promise === promise) connection = null;
  });
  return promise;
}

function syncHfButton() {
  const label = hfSession ? `@${hfSession.username}` : "Войти через HF";
  byId("hf-account-label").textContent = label;
  hfButton.setAttribute("aria-label", hfSession ? `Аккаунт Hugging Face ${label}` : "Войти через Hugging Face");
  hfButton.disabled = hfLoading;
}

function showHfDialog(message) {
  byId("hf-account-status").textContent = message;
  hfLogout.hidden = !hfSession;
  if (!hfDialog.open) hfDialog.showModal();
}

async function beginHfLogin() {
  if (hfLoading) return;
  if (hfSession) {
    showHfDialog(`Ты вошёл как @${hfSession.username}. Запросы используют твою квоту ZeroGPU.`);
    return;
  }
  hfLoading = true;
  syncHfButton();
  syncComposer();
  try {
    await startHfLogin();
  } catch (error) {
    hfLoading = false;
    syncHfButton();
    syncComposer();
    showHfDialog(error.message);
  }
}

function clearHfSession() {
  signOutFromHf();
  hfSession = null;
  connection = null;
  syncHfButton();
}

function quotaAnswer(message, authenticated) {
  const quota = readQuotaError(message);
  if (!quota) return null;
  const limit = authenticated ? "доступном лимите" : "гостевом лимите";
  const text = quota.requested !== undefined
    ? `Для запроса нужно ${seconds.format(quota.requested)} с GPU, а в ${limit} осталось ${seconds.format(quota.remaining)} с.`
    : `ZeroGPU отклонил запрос по ${authenticated ? "лимиту GPU" : "гостевому лимиту"}.`;
  return { text, ok: false, guestQuota: !authenticated };
}

async function sendMessage(message) {
  if (hfSession && hfSession.expiresAt <= Date.now()) {
    clearHfSession();
    showHfDialog("Срок входа истёк. Войди заново, чтобы использовать личную квоту.");
    return;
  }
  const token = hfSession?.token;
  const chat = active;
  const turn = { id: crypto.randomUUID(), question: message, steps: [], answer: null };
  if (!chat.turns.length) chat.title = message.replace(/\s+/g, " ").slice(0, 70);
  chat.turns.push(turn);
  chats = [chat, ...chats.filter((recent) => recent !== chat)];
  processing = turn;
  question.value = "";
  syncComposer();
  renderHistory();
  updateTitle();
  scrollWithUpdate(() => {
    const row = makeTurn(turn);
    row.querySelector(".question").classList.add("message-enter");
    thread.append(row);
  }, true);
  saveChats();

  try {
    const client = await connect(token);
    if (!client.config.dependencies.some((endpoint) => endpoint.api_name === "respond_events")) {
      throw new Error("В Space нет потока событий. Нужно обновить его версию.");
    }
    let retryLabel;
    const job = streamSpaceEvents(client, message, (budget) => {
      retryLabel = `Повторяю с бюджетом ${seconds.format(budget)} с GPU…`;
      setTurnProgress(turn, "waiting", retryLabel);
    });
    for await (const event of job) {
      if (event.type === "status") {
        if (event.stage === "pending" && !turn.steps.length) {
          const queueLabel = event.position > 0 ? `В очереди · ${event.position + 1}` : undefined;
          setTurnProgress(turn, "waiting", retryLabel ?? queueLabel);
        }
        if (event.stage === "generating" && !turn.steps.length) {
          setTurnProgress(turn, "thinking");
        }
        continue;
      }
      if (event.type !== "data") continue;
      const raw = event.data[0];
      const update = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (update.type === "answer") {
        turn.answer = { text: update.text, ok: update.ok };
        if (typeof update.presentation?.lead === "string") turn.answer.presentation = update.presentation;
        if (update.web_result) turn.answer.webResult = update.web_result;
        break;
      }
      if (update.type === "thinking") {
        const step = turn.steps.find((entry) => entry.id === update.id);
        if (!step?.streams_text) continue;
        step.thinkingText = (step.thinkingText ?? "") + update.delta;
        if (active === chat) {
          const row = views.get(turn.id).stepRows.get(step.id);
          scrollWithUpdate(() => renderThinkingText(row, step));
        }
        continue;
      }
      if (update.type !== "step") continue;
      const position = turn.steps.findIndex((step) => step.id === update.id);
      const previous = turn.steps[position];
      if (previous && isThinking(previous)) {
        update.phase = "thinking";
        update.streams_text ??= previous.streams_text;
        if (previous.thinkingText) update.thinkingText = previous.thinkingText;
      }
      measureThinking(update, previous);
      if (position === -1) turn.steps.push(update);
      else turn.steps[position] = update;
      updateTurnProgress(turn, update);
      if (active === chat) scrollWithUpdate(() => renderStep(turn, update));
    }
    if (!turn.answer) throw new Error("Поток событий завершился до получения ответа.");
  } catch (error) {
    const message = error.message || String(error);
    const quota = quotaAnswer(message, Boolean(token));
    let text = "Не удалось получить ответ от Space. Попробуй отправить запрос ещё раз.";
    if (/нет потока событий/.test(message)) text = message;
    if (token && !quota && /\b(?:401|403|unauthorized|forbidden)\b/i.test(message)) {
      if (hfSession?.token === token) clearHfSession();
      text = "Space отклонил авторизацию Hugging Face. Войди заново и повтори запрос.";
    } else if (!turn.steps.length && /fetch|config|runtime|connect|network/i.test(message)) {
      text = "Не удалось подключиться к Space. Проверь, запущен ли он на Hugging Face.";
    }
    if (connection?.token === token) connection = null;
    turn.answer = quota ?? { text, ok: false };
    console.warn("EvoMind:", token ? message.replaceAll(token, "[скрыто]") : message);
  } finally {
    for (const [position, step] of turn.steps.entries()) {
      if (step.status !== "running") continue;
      const stopped = interruptedStep(step);
      measureThinking(stopped, step);
      turn.steps[position] = stopped;
      if (active === chat) renderStep(turn, stopped);
    }
    delete turn.progress;
    if (active === chat) showLatestAnswer(turn);
    saveChats();
    processing = null;
    syncComposer();
  }
}

composer.onsubmit = (event) => {
  event.preventDefault();
  const message = question.value.trim();
  if (message && !processing) sendMessage(message);
};

question.onkeydown = (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    if (!send.disabled) composer.requestSubmit();
  }
};
question.addEventListener("input", syncComposer);
conversation.addEventListener("scroll", syncJump, { passive: true });
const scrollLayout = new ResizeObserver(syncJump);
scrollLayout.observe(conversation);
scrollLayout.observe(thread);
jump.onclick = () => conversation.scrollTo({
  top: conversation.scrollHeight,
  behavior: reduceMotion.matches ? "instant" : "smooth",
});
document.addEventListener("pointerdown", (event) => {
  if (!chatMenu.contains(event.target)) chatMenu.open = false;
});
chatMenu.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !chatMenu.open) return;
  chatMenu.open = false;
  chatMenu.querySelector("summary").focus();
});

byId("new-chat").onclick = () => {
  selectChat(newChat());
  question.value = "";
  syncComposer();
  question.focus();
};
byId("search").oninput = renderHistory;
byId("sidebar-toggle").onclick = () => setSidebar(!byId("sidebar").classList.contains("open"));
conversation.onclick = () => setSidebar(false);
hfButton.onclick = beginHfLogin;
hfLogout.onclick = () => {
  clearHfSession();
  hfDialog.close();
  hfButton.focus();
};
window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  hfSession = readHfSession();
  hfLoading = false;
  syncHfButton();
  syncComposer();
});
for (const example of document.querySelectorAll("[data-example]")) {
  example.onclick = () => {
    question.value = example.dataset.prompt ?? example.querySelector(".example-label").textContent;
    syncComposer();
    question.focus();
  };
}

const library = byId("library");
byId("open-library").onclick = async () => {
  const content = byId("library-content");
  content.textContent = "Загружаю библиотеку…";
  library.showModal();
  try {
    const client = await connect(readHfSession()?.token);
    const response = await client.predict("/list_tools", []);
    const tools = response.data[0];
    content.replaceChildren();
    if (!tools.length) content.textContent = "В библиотеке пока нет инструментов.";
    for (const tool of tools) {
      const card = element("article", "library-card");
      card.append(element("strong", "", tool.name), element("small", "", `${tool.tool_id} · v${tool.version}`),
        element("p", "", tool.description));
      content.append(card);
    }
  } catch {
    content.textContent = "Не удалось загрузить библиотеку. Проверь состояние Space.";
  }
};

const rename = byId("rename-dialog");
const renameValue = byId("rename-value");
byId("rename-chat").onclick = () => {
  chatMenu.open = false;
  renameValue.value = active.title;
  rename.returnValue = "";
  rename.showModal();
  renameValue.select();
};
rename.onclose = () => {
  const name = renameValue.value.trim();
  if (rename.returnValue !== "save" || !name) return;
  active.title = name;
  saveChats();
  updateTitle();
  renderHistory();
};

byId("export-chat").onclick = () => {
  chatMenu.open = false;
  const blob = new Blob([JSON.stringify(active, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = element("a");
  link.href = url;
  link.download = "evomind-chat.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

selectChat(active);
syncComposer();
try {
  hfSession = (await completeHfLogin()) ?? hfSession;
} catch (error) {
  showHfDialog(error.message);
} finally {
  hfLoading = false;
  syncHfButton();
  syncComposer();
}
