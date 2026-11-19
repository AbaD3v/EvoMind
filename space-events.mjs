export function readQuotaError(message) {
  if (!/\bquota\b|квот/i.test(message)) return null;
  const match = message.match(/(\d+(?:\.\d+)?)\s*s\s+requested\s+vs\.?\s*(\d+(?:\.\d+)?)\s*s\s+left/i);
  return match ? { requested: Number(match[1]), remaining: Number(match[2]) } : {};
}

export async function* streamSpaceEvents(client, message, onRetry) {
  const canReduceBudget = client.config.dependencies.some(
    (endpoint) => endpoint.api_name === "respond_events_budgeted",
  );
  let budget;
  for (let attempt = 0; ; attempt++) {
    let started = false;
    try {
      const job = budget === undefined
        ? client.submit("/respond_events", { message })
        : client.submit("/respond_events_budgeted", { message, gpu_seconds: budget });
      for await (const event of job) {
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
      onRetry(budget);
    }
  }
}
