/**
 * MAX Bot API HTTP client.
 * https://platform-api.max.ru
 */

import type { MaxUpdatesResponse } from "./types.js";

const MAX_API = "https://platform-api.max.ru";
const REQUEST_TIMEOUT_MS = 30_000;
const LONG_POLL_TIMEOUT_SEC = 30;

// ─── Low-level fetch helper ───────────────────────────────────────────────────

async function maxRequest<T>(
  token: string,
  method: "GET" | "POST" | "DELETE",
  path: string,
  params?: Record<string, string | number>,
  body?: unknown,
): Promise<T> {
  const url = new URL(`${MAX_API}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
  }

  const headers: Record<string, string> = {
    Authorization: token,
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`MAX API ${method} ${path} → ${res.status}: ${text}`);
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Send a text message to a MAX user (DM).
 */
export async function sendDm(token: string, userId: number, text: string): Promise<boolean> {
  try {
    await maxRequest(token, "POST", "/messages", { user_id: userId }, { text, format: "markdown" });
    return true;
  } catch (err) {
    console.warn(`[openclaw-max] sendDm error: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * Send a text message to a MAX chat.
 */
export async function sendToChat(token: string, chatId: number, text: string): Promise<boolean> {
  try {
    await maxRequest(token, "POST", "/messages", { chat_id: chatId }, { text, format: "markdown" });
    return true;
  } catch (err) {
    console.warn(`[openclaw-max] sendToChat error: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * Long-poll for new updates.
 * Returns updates + next marker.
 */
export async function getUpdates(
  token: string,
  marker?: number | null,
  timeoutSec = LONG_POLL_TIMEOUT_SEC,
  signal?: AbortSignal,
): Promise<MaxUpdatesResponse> {
  const params: Record<string, string | number> = { timeout: timeoutSec, limit: 100 };
  if (marker != null) params.marker = marker;

  const url = new URL(`${MAX_API}/updates`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const controller = new AbortController();
  // Combine external abort signal with our timeout
  const combinedSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout((timeoutSec + 10) * 1000)])
    : AbortSignal.timeout((timeoutSec + 10) * 1000);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: token },
      signal: combinedSignal,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GET /updates → ${res.status}: ${text}`);
    }
    return (await res.json()) as MaxUpdatesResponse;
  } catch (err) {
    if ((err as Error)?.name === "AbortError" || (err as Error)?.name === "TimeoutError") {
      return { updates: [], marker };
    }
    throw err;
  }
}

/**
 * Register a webhook URL with MAX.
 */
export async function subscribeWebhook(
  token: string,
  webhookUrl: string,
  secret?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    url: webhookUrl,
    update_types: ["message_created", "bot_started", "message_callback"],
  };
  if (secret) body.secret = secret;

  await maxRequest(token, "POST", "/subscriptions", undefined, body);
}

/**
 * Remove active webhook subscription (switches back to long polling).
 */
export async function deleteWebhook(token: string): Promise<void> {
  await maxRequest(token, "DELETE", "/subscriptions", undefined, {});
}

/**
 * Get bot info (used to verify token on startup).
 */
export async function getBotInfo(token: string): Promise<{ name: string; username: string }> {
  return maxRequest(token, "GET", "/me");
}
