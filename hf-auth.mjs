const HF = "https://huggingface.co";
const LIVE_SITE = "https://evomind-two.vercel.app";
const SESSION_KEY = "evomind.hf.session";
const LOGIN_KEY = "evomind.hf.login";
const LOGIN_TIMEOUT = 10 * 60 * 1000;

function clientId() {
  const configured = document.querySelector('meta[name="evomind-oauth-client-id"]')?.content.trim();
  return configured || (location.origin === LIVE_SITE ? `${LIVE_SITE}/.well-known/oauth-cimd.json` : "");
}

function readSessionItem(key) {
  try {
    return JSON.parse(sessionStorage.getItem(key));
  } catch {
    return null;
  }
}

function urlSafe(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function readHfSession() {
  const session = readSessionItem(SESSION_KEY);
  if (typeof session?.token === "string" && typeof session.username === "string" && session.expiresAt > Date.now()) {
    return session;
  }
  if (session) sessionStorage.removeItem(SESSION_KEY);
  return null;
}

export function signOutFromHf() {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(LOGIN_KEY);
}

export async function startHfLogin() {
  const client = clientId();
  if (!client) throw new Error("Для этого адреса сайта нужен публичный OAuth Client ID Hugging Face.");

  const state = urlSafe(crypto.getRandomValues(new Uint8Array(32)));
  const verifier = urlSafe(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const redirect = new URL("./", location.href).href;
  sessionStorage.setItem(LOGIN_KEY, JSON.stringify({ state, verifier, client, redirect, startedAt: Date.now() }));

  const url = new URL("/oauth/authorize", HF);
  url.search = new URLSearchParams({
    client_id: client,
    redirect_uri: redirect,
    response_type: "code",
    scope: "openid profile",
    state,
    code_challenge: urlSafe(new Uint8Array(challenge)),
    code_challenge_method: "S256",
  });
  location.assign(url.href);
}

export async function completeHfLogin() {
  const url = new URL(location.href);
  if (!url.searchParams.has("code") && !url.searchParams.has("error")) return null;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  for (const parameter of ["code", "state", "error", "error_description", "error_uri", "iss"]) {
    url.searchParams.delete(parameter);
  }
  history.replaceState(history.state, "", url);

  const login = readSessionItem(LOGIN_KEY);
  sessionStorage.removeItem(LOGIN_KEY);
  if (!login || state !== login.state || Date.now() - login.startedAt > LOGIN_TIMEOUT) {
    throw new Error("Сессия входа устарела. Нажми «Войти через HF» ещё раз.");
  }
  if (error === "access_denied") throw new Error("Вход отменён. Можно продолжить как гость.");
  if (!code || error) throw new Error("Hugging Face не завершил вход. Попробуй ещё раз.");

  const tokenResponse = await fetch(`${HF}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: login.verifier,
      client_id: login.client,
      redirect_uri: login.redirect,
    }),
    redirect: "error",
  });
  if (!tokenResponse.ok) throw new Error("Hugging Face не выдал токен входа. Попробуй ещё раз.");
  const { access_token: token, expires_in: lifetime } = await tokenResponse.json();
  if (typeof token !== "string" || !token || !Number.isFinite(lifetime) || lifetime <= 0) {
    throw new Error("Hugging Face вернул неполные данные сессии.");
  }

  const expiresAt = Date.now() + lifetime * 1000;
  const profile = await fetch(`${HF}/oauth/userinfo`, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "error",
  });
  if (!profile.ok) throw new Error("Не удалось загрузить профиль Hugging Face.");
  const { preferred_username: username } = await profile.json();
  if (typeof username !== "string" || !username) throw new Error("В профиле Hugging Face нет имени пользователя.");

  const session = { token, username, expiresAt };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}
