import { readQuotaError } from "./space-events.mjs";

function result(kind, title, message, { retryable = true, login = false, openSpace = false } = {}) {
  return { kind, title, message, retryable, login, openSpace };
}

// Only fixed copy and validated numbers reach the interface. Exception text can
// contain credentials, internal URLs or server traces and must remain private.
export function classifyRequestError(error, { authenticated = false, online = true } = {}) {
  const message = typeof error === "string" ? error : typeof error?.message === "string" ? error.message : "";
  const name = typeof error?.name === "string" ? error.name : "";
  const code = typeof error?.code === "string" ? error.code : "";
  const status = Number(error?.status ?? error?.statusCode ?? error?.response?.status);
  const description = `${name} ${code} ${message}`;

  if (name === "AbortError" || code === "REQUEST_CANCELLED" || error?.cancelled === true) {
    return result("cancelled", "Запрос остановлен", "Можно изменить сообщение и отправить его снова.", { retryable: false });
  }
  if (!online) {
    return result("offline", "Нет подключения к интернету", "Проверь подключение и повтори запрос.");
  }
  if (name === "TimeoutError" || /REQUEST_TIMEOUT|ETIMEDOUT|\btimeout\b|timed?\s*out|время ожидания/i.test(description)) {
    return result("timeout", "Ответ не пришёл вовремя", "Сервер долго не присылал обновления. Попробуй повторить запрос или открыть Space.", { openSpace: true });
  }

  const quota = readQuotaError(message);
  if (quota) {
    const seconds = Number.isFinite(quota.requested) && Number.isFinite(quota.remaining)
      ? ` Нужно ${quota.requested} с GPU, доступно ${quota.remaining} с.`
      : "";
    const action = authenticated
      ? " Подожди восстановления квоты и повтори запрос."
      : " Войди через Hugging Face, чтобы использовать квоту своего аккаунта, или попробуй позже.";
    return result("quota", "Недостаточно квоты GPU", `Space ограничил доступное время вычислений.${seconds}${action}`, {
      login: !authenticated,
      openSpace: true,
    });
  }
  if ([401, 403].includes(status) || /\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid.*token|token.*expired|authentication required|not authenticated/i.test(description)) {
    return result("auth", "Нужно войти в Hugging Face", authenticated
      ? "Сессия могла истечь или аккаунту не хватает доступа к Space. Войди снова и проверь доступ."
      : "Для этого запроса требуется вход в Hugging Face. После входа отправь сообщение снова.", {
      retryable: false,
      login: true,
      openSpace: true,
    });
  }
  if ([404, 500, 502, 503, 504].includes(status) || /\b(?:500|502|503|504)\b|sleeping|paused|waking|building|space.*(?:unavailable|not found|error)|service unavailable|bad gateway|runtime error|сервер.*недоступ|space.*недоступ/i.test(description)) {
    return result("unavailable", "Space временно недоступен", "Сервер может запускаться или перезапускаться. Подожди немного и повтори запрос; состояние можно проверить в Space.", { openSpace: true });
  }
  if (name === "ProtocolError" || name === "SyntaxError" || /INVALID_RESPONSE|invalid.*(?:response|json)|unexpected.*(?:response|token|json)|malformed|protocol|empty response|некоррект.*ответ|неверн.*ответ|пуст.*ответ/i.test(description)) {
    return result("protocol", "Не удалось прочитать ответ", "Сервер вернул ответ в неподдерживаемом формате. Повтори запрос; если это повторится, проверь Space.", { openSpace: true });
  }
  if (/failed to fetch|fetch failed|network(?:error| error| request)?|load failed|ECONN|ENOTFOUND|connection|соединени|ошибка сети/i.test(description)) {
    return result("network", "Соединение с сервером прервалось", "Проверь интернет и повтори запрос. Если соединение в порядке, Space может быть временно недоступен.", { openSpace: true });
  }
  return result("generic", "Не удалось получить ответ", "Попробуй отправить сообщение ещё раз. Если ошибка повторится, проверь состояние Space.", { openSpace: true });
}
