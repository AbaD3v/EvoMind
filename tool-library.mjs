import { classifyRequestError } from "./request-errors.mjs";

function node(tag, className = "", text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function protocolError() {
  return Object.assign(new Error("INVALID_RESPONSE"), { name: "ProtocolError", code: "INVALID_RESPONSE" });
}

async function withDeadline(work, signal) {
  let timer;
  let onAbort;
  try {
    const interruption = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("REQUEST_TIMEOUT"), { name: "TimeoutError" })), 30_000);
      onAbort = () => reject(Object.assign(new Error("REQUEST_CANCELLED"), { name: "AbortError" }));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    return await Promise.race([
      Promise.resolve().then(() => signal.aborted ? Promise.reject(Object.assign(new Error("REQUEST_CANCELLED"), { name: "AbortError" })) : work()),
      interruption,
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function readTools(response) {
  const tools = response?.data?.[0];
  if (!Array.isArray(tools)) throw protocolError();
  for (const tool of tools) {
    if (!tool || typeof tool.tool_id !== "string" || !tool.tool_id.trim() ||
        typeof tool.name !== "string" || !tool.name.trim() || typeof tool.description !== "string" ||
        !(typeof tool.version === "string" || (typeof tool.version === "number" && Number.isFinite(tool.version)))) {
      throw protocolError();
    }
  }
  return [...tools].sort((left, right) => left.name.localeCompare(right.name, "ru"));
}

function toolCount(count) {
  const suffix = new Intl.PluralRules("ru").select(count);
  return `${count} ${{ one: "инструмент", few: "инструмента", many: "инструментов", other: "инструмента" }[suffix]}`;
}

export function createToolLibrary({ connect, onUse, onAuthError, onLogin, onConnectionError, spaceUrl }) {
  const panel = document.getElementById("library");
  const search = document.getElementById("library-search");
  const count = document.getElementById("library-count");
  const refreshButton = document.getElementById("library-refresh");
  const state = document.getElementById("library-state");
  const content = document.getElementById("library-content");
  let tools = [];
  let requestId = 0;
  let active;
  let loaded = false;

  function setBusy(busy) {
    panel.setAttribute("aria-busy", String(busy));
    content.setAttribute("aria-busy", String(busy));
    refreshButton.disabled = busy;
  }

  function showState(title, message, retry = false) {
    state.hidden = false;
    state.replaceChildren(node("strong", "library-state-title", title), node("p", "", message));
    if (retry) {
      const button = node("button", "small-button", "Повторить загрузку");
      button.type = "button";
      button.addEventListener("click", refresh);
      state.append(button);
    }
  }

  function makeCard(tool) {
    const card = node("details", "library-card");
    const heading = node("summary", "tool-heading");
    heading.append(node("span", "tool-name", tool.name), node("span", "tool-version", `v${tool.version}`),
      node("span", "tool-description", tool.description || "Описание не указано."));
    const details = node("div", "tool-details");
    details.append(node("p", "tool-full-description", tool.description || "У этого инструмента пока нет описания."));
    const meta = node("dl", "tool-meta");
    meta.append(node("dt", "", "ID"), node("dd", "", tool.tool_id),
      node("dt", "", "Версия"), node("dd", "", String(tool.version)));
    details.append(meta);
    for (const [field, title] of [["input_schema", "Входные данные"], ["output_schema", "Результат"], ["source", "Исходный код"]]) {
      if (tool[field] === undefined || tool[field] === null || tool[field] === "") continue;
      const value = typeof tool[field] === "string" ? tool[field] : JSON.stringify(tool[field], null, 2);
      const pre = node("pre", "tool-code");
      pre.append(node("code", "", value));
      details.append(node("h3", "tool-section-title", title), pre);
    }
    details.append(node("p", "tool-note", "Спроси EvoMind о примерах применения или коде этого инструмента."));
    const reference = `${JSON.stringify(tool.name)} (ID: ${JSON.stringify(tool.tool_id)}, версия: ${JSON.stringify(tool.version)})`;
    const actions = node("div", "tool-actions");
    for (const [label, prompt] of [
      ["Как использовать", `Объясни, как использовать инструмент ${reference}. Покажи пример входных данных и ожидаемого результата на основе реальных сведений об инструменте.`],
      ["Показать код", `Покажи исходный код инструмента ${reference}. Если исходный код недоступен, так и скажи.`],
    ]) {
      const button = node("button", "small-button", label);
      button.type = "button";
      button.addEventListener("click", () => {
        panel.close();
        onUse(prompt);
      });
      actions.append(button);
    }
    details.append(actions);
    card.append(heading, details);
    return card;
  }

  function render() {
    if (!loaded) return;
    const query = search.value.trim().toLocaleLowerCase("ru");
    const filtered = tools.filter((tool) => [tool.name, tool.description, tool.tool_id].some((value) => value.toLocaleLowerCase("ru").includes(query)));
    content.replaceChildren(...filtered.map(makeCard));
    count.textContent = query ? `Найдено: ${filtered.length} из ${tools.length}` : toolCount(tools.length);
    if (!tools.length) {
      showState("В библиотеке пока нет инструментов", "Обнови список, когда в Space появятся новые инструменты.");
    } else if (!filtered.length) {
      showState("Ничего не найдено", "Попробуй другое название, описание или ID инструмента.");
    } else {
      state.hidden = true;
      state.replaceChildren();
    }
  }

  async function refresh() {
    if (!panel.open) return;
    const current = ++requestId;
    active?.abort();
    const controller = new AbortController();
    active = controller;
    loaded = false;
    tools = [];
    count.textContent = "";
    content.replaceChildren(...Array.from({ length: 3 }, () => {
      const skeleton = node("div", "library-skeleton");
      skeleton.setAttribute("aria-hidden", "true");
      return skeleton;
    }));
    showState("Загружаем инструменты…", "Получаем актуальный список из Space.");
    setBusy(true);
    try {
      const response = await withDeadline(async () => {
        const client = await connect();
        if (controller.signal.aborted) throw Object.assign(new Error("REQUEST_CANCELLED"), { name: "AbortError" });
        return client.predict("/list_tools", []);
      }, controller.signal);
      if (current !== requestId || !panel.open) return;
      tools = readTools(response);
      loaded = true;
      render();
    } catch (error) {
      if (current !== requestId || !panel.open) return;
      tools = [];
      content.replaceChildren();
      count.textContent = "";
      const failure = classifyRequestError(error, { online: navigator.onLine });
      if (failure.kind === "cancelled") return;
      showState(failure.title, failure.message, true);
      onConnectionError?.();
      if (failure.kind === "auth") onAuthError?.(failure);
      if (failure.login && onLogin) {
        const login = node("button", "small-button", "Войти через HF");
        login.type = "button";
        login.onclick = () => { panel.close(); onLogin(); };
        state.append(login);
      }
      if (failure.openSpace && spaceUrl) {
        const link = node("a", "small-button quota-link", "Открыть Space ↗");
        link.href = spaceUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        state.append(link);
      }
    } finally {
      if (current === requestId) {
        active = undefined;
        setBusy(false);
      }
    }
  }

  function open() {
    if (!panel.open) panel.showModal();
    search.focus();
    return refresh();
  }

  search.addEventListener("input", render);
  refreshButton.addEventListener("click", refresh);
  panel.addEventListener("close", () => {
    requestId++;
    active?.abort();
    active = undefined;
    setBusy(false);
  });
  return { open, refresh };
}
