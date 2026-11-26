export function readQuotaError(message) {
  if (typeof message !== "string") return null;
  if (!/\bquota\b|квот/i.test(message)) return null;
  const match = message.match(/(?:^|[^\w.+-])(-?\d+(?:\.\d+)?)\s*s\s+requested\s+vs\.?\s*(-?\d+(?:\.\d+)?)\s*s\s+left/i);
  if (!match) return {};
  const requested = Number(match[1]);
  const remaining = Number(match[2]);
  return Number.isFinite(requested) && Number.isFinite(remaining) && requested >= 0 && remaining >= 0
    ? { requested, remaining }
    : {};
}

function requestError(name, code) {
  return Object.assign(new Error(code), { name, code });
}

function cancelledError() {
  return requestError("AbortError", "REQUEST_CANCELLED");
}

// A Space can stop producing events without closing its iterator. Each pending
// read has its own deadline; no timer or abort listener survives a yielded event.
async function nextEvent(iterator, signal, timeoutMs) {
  if (signal?.aborted) throw cancelledError();
  let timer;
  let onAbort;
  try {
    const interruption = new Promise((_, reject) => {
      timer = setTimeout(() => reject(requestError("TimeoutError", "REQUEST_TIMEOUT")), timeoutMs);
      if (signal) {
        onAbort = () => reject(cancelledError());
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    return await Promise.race([Promise.resolve().then(() => iterator.next()), interruption]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function closeJob(job, iterator) {
  // Gradio cancellation and iterator cleanup may themselves fail or hang when
  // disconnected. Request cleanup without delaying the UI's cancellation.
  for (const [target, method] of [[job, "cancel"], [iterator, "return"]]) {
    try {
      if (typeof target?.[method] === "function") {
        Promise.resolve(target[method]()).catch(() => {});
      }
    } catch {
      // The original request failure remains the relevant error.
    }
  }
}

export async function* streamSpaceEvents(client, message, onRetry, { signal, timeoutMs = 150_000 } = {}) {
  const deadline = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 150_000) : 150_000;
  const canReduceBudget = Array.isArray(client.config?.dependencies) && client.config.dependencies.some(
    (endpoint) => endpoint.api_name === "respond_events_budgeted",
  );
  let budget;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw cancelledError();
    let started = false;
    let job;
    let iterator;
    let completed = false;
    try {
      job = budget === undefined
        ? client.submit("/respond_events", { message })
        : client.submit("/respond_events_budgeted", { message, gpu_seconds: budget });
      if (typeof job?.[Symbol.asyncIterator] !== "function") {
        throw requestError("ProtocolError", "INVALID_RESPONSE");
      }
      iterator = job[Symbol.asyncIterator]();
      while (true) {
        const next = await nextEvent(iterator, signal, deadline);
        if (!next || typeof next !== "object") throw requestError("ProtocolError", "INVALID_RESPONSE");
        if (next.done) {
          completed = true;
          break;
        }
        const event = next.value;
        if (!event || typeof event.type !== "string") throw requestError("ProtocolError", "INVALID_RESPONSE");
        if (event.type === "status" && event.stage === "error") {
          throw new Error(event.message || "Space завершил запрос с ошибкой.");
        }
        if (event.type === "data") started = true;
        yield event;
      }
      return;
    } catch (error) {
      if (started || !canReduceBudget || attempt >= 2) throw error;
      const quota = readQuotaError(error?.message || String(error));
      if (!quota || !(quota.remaining > 0 && quota.remaining <= quota.requested)) throw error;

      // The scheduler reports rounded quota seconds. Leave room for rounding after a denied retry.
      const smaller = budget === undefined
        ? Math.min(Math.floor(quota.remaining), Math.ceil(quota.requested) - 1)
        : Math.floor((quota.remaining - 1) / Math.max(1, quota.requested / budget));
      if (smaller < 1 || (budget !== undefined && smaller >= budget)) throw error;
      budget = smaller;
      onRetry?.(budget);
    } finally {
      if (!completed) closeJob(job, iterator);
    }
  }
}
