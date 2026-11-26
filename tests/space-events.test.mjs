import test from "node:test";
import assert from "node:assert/strict";
import { readQuotaError, streamSpaceEvents } from "../space-events.mjs";

function fakeJob(events = [], { pending = false, cancelFails = false } = {}) {
  let offset = 0;
  const counts = { cancel: 0, returned: 0, next: 0 };
  return {
    counts,
    [Symbol.asyncIterator]() { return this; },
    next() {
      counts.next++;
      if (offset < events.length) {
        const event = events[offset++];
        return event instanceof Error ? Promise.reject(event) : Promise.resolve({ value: event, done: false });
      }
      return pending ? new Promise(() => {}) : Promise.resolve({ done: true });
    },
    cancel() {
      counts.cancel++;
      if (cancelFails) return Promise.reject(new Error("cancel transport failed"));
    },
    return() { counts.returned++; return Promise.resolve({ done: true }); },
  };
}

function fakeClient(jobs, { budgeted = false } = {}) {
  const calls = [];
  return {
    calls,
    config: { dependencies: budgeted ? [{ api_name: "respond_events_budgeted" }] : [] },
    submit(endpoint, payload) {
      calls.push({ endpoint, payload });
      const job = jobs[calls.length - 1];
      assert.ok(job, "unexpected retry");
      return job;
    },
  };
}

function trackedSignal() {
  const controller = new AbortController();
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  let listeners = 0;
  controller.signal.addEventListener = (...args) => { listeners++; originalAdd(...args); };
  controller.signal.removeEventListener = (...args) => { listeners--; originalRemove(...args); };
  return { controller, get listeners() { return listeners; } };
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

test("normal completion yields all events and releases listeners", async () => {
  const events = [{ type: "status", stage: "pending" }, { type: "data", data: ["hello"] }];
  const job = fakeJob(events);
  const client = fakeClient([job]);
  const tracked = trackedSignal();
  assert.deepEqual(await collect(streamSpaceEvents(client, "hello", null, { signal: tracked.controller.signal, timeoutMs: 30 })), events);
  assert.equal(tracked.listeners, 0);
  assert.equal(job.counts.cancel, 0);
  assert.equal(job.counts.returned, 0);
});

test("midstream failures retain the error and never retry partial work", async () => {
  const failure = new Error("GPU quota exceeded (120s requested vs. 30s left)");
  const job = fakeJob([{ type: "data", data: ["partial"] }, failure]);
  const client = fakeClient([job], { budgeted: true });
  const seen = [];
  await assert.rejects(async () => {
    for await (const event of streamSpaceEvents(client, "hello", () => assert.fail("partial work must not retry"))) seen.push(event);
  }, (error) => error === failure);
  assert.equal(seen.length, 1);
  assert.equal(client.calls.length, 1);
  assert.equal(job.counts.cancel, 1);
  assert.equal(job.counts.returned, 1);
});

test("quota retries reduce GPU budget and stop after two retries", async () => {
  const failure = { type: "status", stage: "error", message: "GPU quota exceeded (120s requested vs. 30s left)" };
  const jobs = [fakeJob([failure]), fakeJob([failure]), fakeJob([failure])];
  const client = fakeClient(jobs, { budgeted: true });
  const budgets = [];
  await assert.rejects(collect(streamSpaceEvents(client, "hello", (budget) => budgets.push(budget))), /quota/);
  assert.deepEqual(budgets, [30, 7]);
  assert.deepEqual(client.calls.map((call) => call.payload.gpu_seconds), [undefined, 30, 7]);
  assert.deepEqual(client.calls.map((call) => call.endpoint), ["/respond_events", "/respond_events_budgeted", "/respond_events_budgeted"]);
  for (const job of jobs) {
    assert.equal(job.counts.cancel, 1);
    assert.equal(job.counts.returned, 1);
  }
});

test("quota retry can complete successfully", async () => {
  const failed = fakeJob([new Error("GPU quota exceeded (120s requested vs. 12s left)")]);
  const successful = fakeJob([{ type: "data", data: ["done"] }]);
  const client = fakeClient([failed, successful], { budgeted: true });
  const events = await collect(streamSpaceEvents(client, "hello"));
  assert.deepEqual(events, [{ type: "data", data: ["done"] }]);
  assert.equal(client.calls[1].payload.gpu_seconds, 12);
  assert.equal(failed.counts.cancel, 1);
  assert.equal(successful.counts.cancel, 0);
});

test("zero quota and unavailable budget endpoint do not retry", async () => {
  for (const [budgeted, remaining] of [[true, 0], [false, 30]]) {
    const client = fakeClient([fakeJob([new Error(`GPU quota exceeded (120s requested vs. ${remaining}s left)`)])], { budgeted });
    await assert.rejects(collect(streamSpaceEvents(client, "hello")), /quota/);
    assert.equal(client.calls.length, 1);
  }
});

test("inactivity timeout cancels the job and clears the abort listener", async () => {
  const job = fakeJob([], { pending: true });
  const client = fakeClient([job]);
  const tracked = trackedSignal();
  await assert.rejects(collect(streamSpaceEvents(client, "hello", null, { signal: tracked.controller.signal, timeoutMs: 10 })), { name: "TimeoutError", code: "REQUEST_TIMEOUT" });
  assert.equal(job.counts.cancel, 1);
  assert.equal(job.counts.returned, 1);
  assert.equal(tracked.listeners, 0);
});

test("abort interrupts a pending read even when remote cleanup fails", async () => {
  const job = fakeJob([], { pending: true, cancelFails: true });
  const client = fakeClient([job]);
  const tracked = trackedSignal();
  const result = collect(streamSpaceEvents(client, "hello", null, { signal: tracked.controller.signal, timeoutMs: 1000 }));
  tracked.controller.abort();
  await assert.rejects(result, { name: "AbortError", code: "REQUEST_CANCELLED" });
  assert.equal(job.counts.cancel, 1);
  assert.equal(job.counts.returned, 1);
  assert.equal(tracked.listeners, 0);
});

test("pre-aborted requests never submit work", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = fakeClient([]);
  await assert.rejects(collect(streamSpaceEvents(client, "hello", null, { signal: controller.signal })), { name: "AbortError" });
  assert.equal(client.calls.length, 0);
});

test("breaking out closes the job without leaving an active listener", async () => {
  const job = fakeJob([{ type: "data", data: ["first"] }], { pending: true });
  const client = fakeClient([job]);
  const tracked = trackedSignal();
  for await (const event of streamSpaceEvents(client, "hello", null, { signal: tracked.controller.signal, timeoutMs: 10 })) {
    assert.equal(event.type, "data");
    break;
  }
  assert.equal(job.counts.cancel, 1);
  assert.equal(job.counts.returned, 1);
  assert.equal(tracked.listeners, 0);
  assert.equal(job.counts.next, 1);
});

test("malformed stream events fail with a protocol classification", async () => {
  const job = fakeJob([null]);
  await assert.rejects(collect(streamSpaceEvents(fakeClient([job]), "hello")), { name: "ProtocolError", code: "INVALID_RESPONSE" });
  assert.equal(job.counts.cancel, 1);
});

test("quota parser rejects invalid numbers and preserves finite fractional seconds", () => {
  assert.equal(readQuotaError("network problem"), null);
  assert.equal(readQuotaError(null), null);
  assert.deepEqual(readQuotaError("GPU quota (10.5s requested vs. 4.25s left)"), { requested: 10.5, remaining: 4.25 });
  assert.deepEqual(readQuotaError("quota -4s requested vs. 2s left"), {});
});
