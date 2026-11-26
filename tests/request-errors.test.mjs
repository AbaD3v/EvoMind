import test from "node:test";
import assert from "node:assert/strict";
import { classifyRequestError } from "../request-errors.mjs";

test("classifies actionable failures without reflecting server details", () => {
  const cases = [
    [Object.assign(new Error("secret hf_not_a_real_token"), { name: "AbortError" }), {}, "cancelled"],
    [new Error("secret"), { online: false }, "offline"],
    [Object.assign(new Error("secret"), { name: "TimeoutError" }), {}, "timeout"],
    [Object.assign(new Error("secret"), { status: 401 }), {}, "auth"],
    [Object.assign(new Error("secret"), { response: { status: 403 } }), {}, "auth"],
    [new Error("Space is sleeping; secret"), {}, "unavailable"],
    [Object.assign(new Error("secret"), { status: 503 }), {}, "unavailable"],
    [Object.assign(new Error("secret"), { code: "INVALID_RESPONSE" }), {}, "protocol"],
    [new SyntaxError("Unexpected token secret"), {}, "protocol"],
    [new TypeError("Failed to fetch secret"), {}, "network"],
    [new Error("server traceback secret hf_not_a_real_token"), {}, "generic"],
    [null, {}, "generic"],
  ];
  for (const [error, options, kind] of cases) {
    const actual = classifyRequestError(error, options);
    assert.equal(actual.kind, kind);
    assert.deepEqual(Object.keys(actual).sort(), ["kind", "login", "message", "openSpace", "retryable", "title"]);
    assert.doesNotMatch(JSON.stringify(actual), /secret|hf_not_a_real_token|traceback/);
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), actual);
  }
});

test("GPU quota keeps only validated seconds and offers guest login", () => {
  const guest = classifyRequestError(new Error("GPU quota exceeded (120s requested vs. 18.5s left) secret"));
  assert.equal(guest.kind, "quota");
  assert.match(guest.message, /120 с GPU, доступно 18\.5 с/);
  assert.equal(guest.login, true);
  assert.equal(guest.openSpace, true);
  assert.doesNotMatch(guest.message, /secret/);

  const signedIn = classifyRequestError(new Error("GPU quota exceeded (120s requested vs. 0s left)"), { authenticated: true });
  assert.equal(signedIn.login, false);
  assert.match(signedIn.message, /доступно 0 с/);
  assert.match(signedIn.message, /восстановления квоты/);
});

test("malformed GPU durations are not copied into messages", () => {
  for (const message of ["quota -5s requested vs. 10s left", "quota 5s requested vs. -10s left", "quota 2e309s requested vs. 10s left", `quota ${"9".repeat(400)}s requested vs. 10s left`]) {
    const error = classifyRequestError(new Error(message));
    assert.equal(error.kind, "quota");
    assert.doesNotMatch(error.message, /Нужно|Infinity|-10|-5|2e309/);
  }
});

test("intentional cancellation stays distinct when offline", () => {
  const error = classifyRequestError({ name: "AbortError" }, { online: false });
  assert.equal(error.kind, "cancelled");
  assert.equal(error.retryable, false);
  assert.equal(error.login, false);
});

test("expired sessions offer login even when previously authenticated", () => {
  const error = classifyRequestError({ statusCode: 401 }, { authenticated: true });
  assert.equal(error.kind, "auth");
  assert.equal(error.login, true);
  assert.match(error.message, /Сессия могла истечь/);
});
