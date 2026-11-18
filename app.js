const CLIENT_MODULE = "https://cdn.jsdelivr.net/npm/@gradio/client@2.8.0/dist/index.min.js";
const SPACE = document.querySelector('meta[name="evomind-space"]').content;
const STORAGE_KEY = "evomind.chats.v1";
const byId = (id) => document.getElementById(id);
const thread = byId("thread");
const conversation = byId("conversation");
const question = byId("question");
const composer = byId("composer");
const send = byId("send");
const jump = byId("jump-latest");
const chatMenu = byId("chat-menu");
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const seconds = new Intl.NumberFormat("ru", { maximumFractionDigits: 1 });
const views = new Map();

let chats = readChats();
let active = chats[0] ?? newChat();
let processing = null;
let clientPromise;

function readChats() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]").map((chat) => ({
      ...chat,
      turns: chat.turns.map((turn) => turn.answer ? turn : {
        ...turn,
        steps: turn.steps.map((step) => step.status === "running" ? { ...step, status: "error" } : step),
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
  const icon = element("span", `icon icon-${name}`);
  icon.setAttribute("aria-hidden", "true");
  return icon;
}

function isThinking(step) {
  return step.title === "Анализирую задачу" || step.title === "Анализ задачи завершён";
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
  emblem.append(element("span", "brand-mark"), element("span", "thinking-result"));
  const dots = element("span", "thinking-dots");
  dots.setAttribute("aria-hidden", "true");
  dots.append(element("span"), element("span"), element("span"));
  heading.querySelector(".step-title").setAttribute("aria-live", "polite");
  heading.append(dots, element("span", "thinking-time"));
}

function renderHistory() {
  const history = byId("history");
  const query = byId("search").value.trim().toLocaleLowerCase("ru");
  const visible = chats.filter((chat) => chat.title.toLocaleLowerCase("ru").includes(query));
  history.replaceChildren();
  for (const chat of visible) {
    const button = element("button", "history-entry", chat.title);
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
  byId("chat-title").textContent = active.title;
  chatMenu.hidden = !active.turns.length;
  byId("empty").hidden = active.turns.length > 0;
  thread.hidden = !active.turns.length;
}

function makeTurn(turn) {
  const row = element("article", "turn");
  const bubble = element("p", "bubble question", turn.question);
  const work = element("details", "work");
  const heading = element("summary", "", "Ход работы");
  const count = element("span", "work-count");
  heading.append(count);
  const steps = element("div", "steps");
  work.append(heading, steps);
  work.open = turn.workOpen ?? true;
  work.ontoggle = () => {
    if (turn.workOpen === work.open) return;
    turn.workOpen = work.open;
    if (views.has(turn.id)) saveChats();
  };
  const reply = element("div", "bubble reply");
  const actions = element("div", "reply-actions");
  work.hidden = reply.hidden = actions.hidden = true;
  row.append(bubble, work, reply, actions);
  const view = { row, work, count, steps, reply, actions, stepRows: new Map() };
  views.set(turn.id, view);
  for (const step of turn.steps) renderStep(turn, step);
  if (turn.answer) renderAnswer(turn);
  return row;
}

function renderStep(turn, step) {
  const view = views.get(turn.id);
  let row = view.stepRows.get(step.id);
  const previousStatus = row?.dataset.status;
  const isGroup = step.group === true;
  const thinking = isThinking(step);
  const expandable = isGroup || step.details.length > 0 || (step.status === "running" && !thinking);
  if (!row) {
    row = element(expandable ? "details" : "div", isGroup ? "step step-group" : "step");
    const heading = element(expandable ? "summary" : "div", "step-heading");
    const symbol = element("span", "step-symbol");
    symbol.setAttribute("aria-hidden", "true");
    heading.append(symbol, element("span", "step-title"));
    if (thinking) {
      row.classList.add("thinking-step");
      buildThinkingHeading(heading);
    }
    row.append(heading, element("div", "step-content"));
    if (isGroup) {
      heading.append(element("span", "substep-count"));
      row.append(element("div", "step-children"));
    }
    if (expandable) {
      row.open = turn.openSteps?.[step.id] ?? isGroup;
      row.ontoggle = () => {
        if ((turn.openSteps?.[step.id] ?? isGroup) === row.open) return;
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
  const statusIcon = { info: "·", running: "", error: "×", success: "✓" }[step.status] ?? "·";
  heading.querySelector(thinking ? ".thinking-result" : ".step-symbol").textContent = statusIcon;
  heading.querySelector(".step-title").textContent = thinking && step.status === "error" ? "Анализ задачи прерван" : step.title;
  if (thinking) {
    heading.querySelector(".thinking-time").textContent =
      Number.isFinite(step.elapsedMs) ? `${seconds.format(step.elapsedMs / 1000)} с` : "";
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
  view.work.hidden = false;
  view.count.textContent = String(turn.steps.length);
}

function renderAnswer(turn) {
  const { reply, actions } = views.get(turn.id);
  const { text, ok } = turn.answer;
  const fencedCode = /\n{2}````python\n([\s\S]*?)\n````\s*$/;
  const match = text.match(fencedCode);
  reply.replaceChildren(element("div", "", match ? text.slice(0, match.index).trimEnd() : text));
  if (match) {
    const pre = element("pre");
    pre.append(element("code", "", match[1]));
    reply.append(pre);
  }
  reply.dataset.ok = String(ok);
  reply.hidden = false;
  if (reply.isConnected) reply.classList.add("message-enter");

  const copy = element("button", "copy");
  copy.type = "button";
  const label = element("span", "", "Копировать");
  label.setAttribute("aria-live", "polite");
  copy.append(lightIcon("copy"), label);
  let copyTimer;
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      copy.dataset.copyState = "copied";
      label.textContent = "Скопировано";
    } catch {
      copy.dataset.copyState = "error";
      label.textContent = "Копирование недоступно";
    }
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      delete copy.dataset.copyState;
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

function syncComposer() {
  send.disabled = Boolean(processing) || !question.value.trim();
  composer.dataset.busy = String(Boolean(processing));
}

function connect() {
  clientPromise ??= import(CLIENT_MODULE)
    .then(({ Client }) => Client.connect(SPACE, { events: ["data", "status"] }))
    .catch((error) => {
      clientPromise = null;
      throw error;
    });
  return clientPromise;
}

function setStatus(text) {
  byId("composer-status").textContent = text;
}

async function sendMessage(message) {
  const chat = active;
  const turn = { id: crypto.randomUUID(), question: message, steps: [], answer: null };
  if (!chat.turns.length) chat.title = message.replace(/\s+/g, " ").slice(0, 70);
  chat.turns.push(turn);
  chats = [chat, ...chats.filter((recent) => recent !== chat)];
  processing = turn;
  question.value = "";
  syncComposer();
  setStatus("Подключаюсь к Space…");
  renderHistory();
  updateTitle();
  scrollWithUpdate(() => {
    const row = makeTurn(turn);
    row.querySelector(".question").classList.add("message-enter");
    thread.append(row);
  }, true);
  saveChats();

  try {
    const client = await connect();
    if (!client.config.dependencies.some((endpoint) => endpoint.api_name === "respond_events")) {
      throw new Error("В Space нет потока событий. Нужно обновить его версию.");
    }
    const job = client.submit("/respond_events", { message });
    for await (const event of job) {
      if (event.type === "status") {
        if (event.stage === "error") throw new Error(event.message || "Space завершил запрос с ошибкой.");
        if (event.stage === "pending" && !turn.steps.length) {
          setStatus(event.position > 0 ? `Место в очереди — ${event.position + 1}` : "Ожидаю запуск…");
        }
        continue;
      }
      if (event.type !== "data") continue;
      const raw = event.data[0];
      const update = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (update.type === "answer") {
        turn.answer = { text: update.text, ok: update.ok };
        break;
      }
      if (update.type !== "step") continue;
      const position = turn.steps.findIndex((step) => step.id === update.id);
      measureThinking(update, turn.steps[position]);
      if (position === -1) turn.steps.push(update);
      else turn.steps[position] = update;
      if (active === chat) scrollWithUpdate(() => renderStep(turn, update));
      setStatus("EvoMind работает…");
    }
    if (!turn.answer) throw new Error("Поток событий завершился до получения ответа.");
  } catch (error) {
    const message = error.message || String(error);
    let text = "Не удалось получить ответ от Space. Попробуй отправить запрос ещё раз.";
    if (/квот|quota/i.test(message)) text = "Квота ZeroGPU исчерпана. Попробуй после её обновления.";
    if (/нет потока событий/.test(message)) text = message;
    if (!turn.steps.length && /fetch|config|runtime|connect|network/i.test(message)) {
      text = "Не удалось подключиться к Space. Проверь, запущен ли он на Hugging Face.";
    }
    clientPromise = null;
    turn.answer = { text, ok: false };
    console.warn("EvoMind:", error);
  } finally {
    for (const step of turn.steps) {
      if (step.status !== "running") continue;
      step.status = "error";
      measureThinking(step);
      if (active === chat) renderStep(turn, step);
    }
    if (active === chat) scrollWithUpdate(() => renderAnswer(turn));
    saveChats();
    processing = null;
    syncComposer();
    setStatus("");
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
byId("example").onclick = () => {
  question.value = byId("example").textContent;
  syncComposer();
  question.focus();
};

const library = byId("library");
byId("open-library").onclick = async () => {
  const content = byId("library-content");
  content.textContent = "Загружаю библиотеку…";
  library.showModal();
  try {
    const client = await connect();
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
