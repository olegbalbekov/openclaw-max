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
  method: "GET" | "POST" | "DELETE" | "PUT",
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
 * Returns the message_id for later editing (streaming), or null on failure.
 */
export async function sendDm(token: string, userId: number, text: string): Promise<string | null> {
  try {
    const res = await maxRequest<{ message?: { body?: { mid?: string } } }>(
      token, "POST", "/messages", { user_id: userId }, { text, format: "markdown" }
    );
    return res?.message?.body?.mid ?? null;
  } catch (err) {
    console.warn(`[openclaw-max] sendDm error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Send a text message to a MAX chat.
 * Returns the message_id for later editing (streaming), or null on failure.
 */
export async function sendToChat(token: string, chatId: number, text: string): Promise<string | null> {
  try {
    const res = await maxRequest<{ message?: { body?: { mid?: string } } }>(
      token, "POST", "/messages", { chat_id: chatId }, { text, format: "markdown" }
    );
    return res?.message?.body?.mid ?? null;
  } catch (err) {
    console.warn(`[openclaw-max] sendToChat error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Edit an existing message (for streaming updates).
 * PUT /messages?message_id={id}
 */
export async function editMessage(token: string, messageId: string, text: string): Promise<boolean> {
  try {
    await maxRequest(token, "PUT", "/messages", { message_id: messageId }, { text, format: "markdown" });
    return true;
  } catch (err) {
    console.warn(`[openclaw-max] editMessage error: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

/**
 * Send typing indicator to a chat.
 * action: "typing_on" | "typing_off" | "sending_photo" | "sending_video" | "sending_audio"
 */
export async function sendTypingAction(
  token: string,
  chatId: number,
  action: "typing_on" | "typing_off" = "typing_on",
): Promise<void> {
  try {
    await maxRequest(token, "POST", `/chats/${chatId}/actions`, {}, { action });
  } catch {
    // Typing is best-effort, never throw
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
