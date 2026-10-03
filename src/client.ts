/**
 * MAX Bot API HTTP client.
 * https://platform-api2.max.ru
 *
 * The MAX Bot API moved off platform-api.max.ru (decommissioned 2026-07-19) to
 * platform-api2.max.ru, whose TLS chain is anchored on the Russian Trusted Root
 * CA (Минцифры) — absent from Node's bundled CA store. We therefore route every
 * request through a dedicated undici dispatcher that trusts that CA in addition
 * to the platform defaults, and optionally through an HTTP(S) proxy.
 */

import tls from "node:tls";
// Import fetch from undici too (not Node's global): the global fetch uses Node's
// built-in undici copy, which rejects a dispatcher built by this (possibly
// different) undici version with UND_ERR_INVALID_ARG. Same-package fetch+Agent
// are guaranteed compatible.
import { fetch, Agent, ProxyAgent, type Dispatcher } from "undici";
import type { MaxUpdatesResponse } from "./types.js";
import { RUSSIAN_TRUSTED_CA } from "./max-ca.js";

const MAX_API = "https://platform-api2.max.ru";
const REQUEST_TIMEOUT_MS = 30_000;
const LONG_POLL_TIMEOUT_SEC = 30;
export class MaxApiError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "MaxApiError";
  }
}

function safeResponseSummary(text: string): string {
  if (!text) return "empty response";
  try {
    const value = JSON.parse(text) as { code?: unknown; message?: unknown };
    const code = typeof value?.code === "string" ? value.code : "unknown";
    const message = typeof value?.message === "string" ? value.message : "no message";
    return `${code}: ${message}`.slice(0, 500);
  } catch {
    return "non-JSON response";
  }
}


// ─── TLS / proxy transport ────────────────────────────────────────────────────

// Trust the Минцифры CA on top of the default root store.
const MAX_CA: string[] = [RUSSIAN_TRUSTED_CA, ...tls.rootCertificates];

let dispatcher: Dispatcher = new Agent({ connect: { ca: MAX_CA } });

/**
 * (Re)configure the HTTP transport for MAX API calls.
 * Call once at channel startup. When `httpProxy` is set, requests are tunnelled
 * through it (fixes GitHub issue #1); the Минцифры CA is trusted either way.
 */
export function configureMaxTransport(opts?: { httpProxy?: string }): void {
  const proxy = opts?.httpProxy?.trim();
  dispatcher = proxy
    ? new ProxyAgent({ uri: proxy, connect: { ca: MAX_CA } })
    : new Agent({ connect: { ca: MAX_CA } });
}

function encodeMultipart(buffer: Buffer, mimeType: string, filename: string): {
  body: Buffer;
  contentType: string;
} {
  const boundary = `----openclaw-max-${crypto.randomUUID()}`;
  const safeName = filename.replace(/[\r\n"]/g, "_");
  // MIME is emitted into a multipart header. Accept only a strict RFC token
  // type/subtype pair; malformed or injected values become inert binary data.
  const mimeToken = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
  const safeMimeType = mimeToken.test(mimeType) ? mimeType : "application/octet-stream";
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="data"; filename="${safeName}"\r\n` +
    `Content-Type: ${safeMimeType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, buffer, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

// ─── Low-level fetch helper ───────────────────────────────────────────────────

async function maxRequest<T>(
  token: string,
  method: "GET" | "POST" | "DELETE" | "PUT",
  path: string,
  params?: Record<string, string | number>,
  body?: unknown,
  signal?: AbortSignal,
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

  const requestSignal = AbortSignal.any([
    AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(signal ? [signal] : []),
  ]);

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: requestSignal,
    dispatcher,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new MaxApiError(
      `MAX API ${method} ${path} → ${res.status}: ${safeResponseSummary(text)}`,
      res.status,
    );
  }
  return JSON.parse(text) as T;
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
 * Delete a bot-sent message (placeholder cleanup on silent/NO_REPLY turns).
 * DELETE /messages?message_id={id}
 */
export async function deleteMessage(token: string, messageId: string): Promise<boolean> {
  try {
    await maxRequest(token, "DELETE", "/messages", { message_id: messageId });
    return true;
  } catch (err) {
    console.warn(`[openclaw-max] deleteMessage error: ${err instanceof Error ? err.message : err}`);
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
 * Отметить переписку прочитанной — вторая галка у сообщения собеседника.
 *
 * ⚠️ Действия `mark_seen` нет в документации (там перечислены `typing_on` и
 * четыре `sending_*`), но API его принимает: проверено живой отправкой
 * 22.09.2026 — `200 {"success":true}`. Без него сообщения собеседника
 * навсегда остаются с одной галкой, будто бот их не читал.
 */
export async function markSeen(token: string, chatId: number): Promise<void> {
  try {
    await maxRequest(token, "POST", `/chats/${chatId}/actions`, {}, { action: "mark_seen" });
  } catch {
    // Отметка о прочтении — вежливость, а не доставка: молчим на сбое.
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

  // Combine external abort signal with our timeout
  const combinedSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout((timeoutSec + 10) * 1000)])
    : AbortSignal.timeout((timeoutSec + 10) * 1000);

  try {
    const res = await fetch(url.toString(), {
      method: "GET",
      headers: { Authorization: token },
      signal: combinedSignal,
      dispatcher,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new MaxApiError(`GET /updates → ${res.status}: ${text}`, res.status);
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
export async function getBotInfo(token: string, signal?: AbortSignal): Promise<{ name: string; username: string }> {
  return maxRequest(token, "GET", "/me", undefined, undefined, signal);
}

/**
 * Скачать файл по URL.
 */
export async function downloadFile(token: string, url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: { Authorization: token },
      dispatcher,
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * Получить URL для загрузки медиафайла.
 * type передаётся как query param.
 */
export async function getUploadUrl(token: string, type: "image" | "video" | "audio" | "file"): Promise<string | null> {
  try {
    const res = await maxRequest<{ url: string }>(token, "POST", "/uploads", { type });
    return res?.url ?? null;
  } catch (err) {
    console.warn(`[openclaw-max] getUploadUrl error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Загрузить файл по upload URL (multipart/form-data).
 * Возвращает { token } из ответа или null.
 */
export async function uploadFile(uploadUrl: string, buffer: Buffer, mimeType: string, filename: string): Promise<{ token: string } | null> {
  try {
    const { body, contentType } = encodeMultipart(buffer, mimeType, filename);
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(body.length),
      },
      body,
      dispatcher,
    });
    if (!res.ok) return null;
    const json = await res.json() as Record<string, unknown>;
    // Direct token at top level
    if (typeof json.token === "string") return { token: json.token };
    // Photos response: { photos: { <key>: { token: string } } }
    if (json.photos && typeof json.photos === "object") {
      const firstVal = Object.values(json.photos as Record<string, unknown>)[0] as Record<string, unknown> | undefined;
      if (firstVal && typeof firstVal.token === "string") return { token: firstVal.token };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Отправить сообщение с изображением в DM.
 */
export async function sendDmWithImage(token: string, userId: number, text: string, imageToken: string): Promise<string | null> {
  try {
    const body: Record<string, unknown> = {
      attachments: [{ type: "image", payload: { token: imageToken } }],
    };
    if (text) body.text = text;
    const res = await maxRequest<{ message?: { body?: { mid?: string } } }>(
      token, "POST", "/messages", { user_id: userId }, body
    );
    return res?.message?.body?.mid ?? null;
  } catch (err) {
    console.warn(`[openclaw-max] sendDmWithImage error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Отправить сообщение с изображением в чат.
 */
export async function sendToChatWithImage(token: string, chatId: number, text: string, imageToken: string): Promise<string | null> {
  try {
    const body: Record<string, unknown> = {
      attachments: [{ type: "image", payload: { token: imageToken } }],
    };
    if (text) body.text = text;
    const res = await maxRequest<{ message?: { body?: { mid?: string } } }>(
      token, "POST", "/messages", { chat_id: chatId }, body
    );
    return res?.message?.body?.mid ?? null;
  } catch (err) {
    console.warn(`[openclaw-max] sendToChatWithImage error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ─── Вложения общего вида (аудио, видео, файлы) ──────────────────────────────
//
// Картинка грузится иначе всего остального, и одними `getUploadUrl` +
// `uploadFile` звук отправить нельзя (проверено живой отправкой 22.09.2026):
//
//  • токен вложения отдаёт ответ `POST /uploads` (поля `url` и `token`), а НЕ
//    ответ загрузчика: для аудио тот возвращает `<retval>1</retval>`, и разбор
//    JSON в `uploadFile` считает удачную загрузку провалом;
//  • сразу после загрузки MAX какое-то время отвечает `attachment.not.ready` —
//    отправку надо переждать и повторить;
//  • OGG/Opus принимается, хотя в документации перечислены MP3, WAV и M4A.

/** Куда грузить файл и каким токеном потом сослаться на него во вложении. */
export interface MaxUploadTarget {
  url: string;
  token: string;
}

/**
 * Создать загрузку: вернуть URL загрузчика ВМЕСТЕ с токеном вложения.
 * Для картинок токен приезжает от самого загрузчика, для остальных типов — отсюда.
 */
export async function createUpload(
  token: string,
  type: "image" | "video" | "audio" | "file",
): Promise<MaxUploadTarget | null> {
  try {
    const res = await maxRequest<Partial<MaxUploadTarget>>(token, "POST", "/uploads", { type });
    return typeof res?.url === "string"
      ? { url: res.url, token: typeof res.token === "string" ? res.token : "" }
      : null;
  } catch (err) {
    console.warn(`[openclaw-max] createUpload error: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * Загрузить файл по URL загрузчика.
 * Возвращает токен, если загрузчик его дал, иначе `{ token: null }` — это НЕ ошибка:
 * загрузчик аудио отвечает `<retval>1</retval>`, а токен берётся у `createUpload`.
 */
export async function uploadToUrl(
  uploadUrl: string,
  buffer: Buffer,
  mimeType: string,
  filename: string,
): Promise<{ token: string | null } | null> {
  try {
    const { body, contentType } = encodeMultipart(buffer, mimeType, filename);
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(body.length),
      },
      body,
      dispatcher,
    });
    if (!res.ok) return null;
    const text = await res.text();
    try {
      const json = JSON.parse(text) as { token?: unknown };
      return { token: typeof json?.token === "string" ? json.token : null };
    } catch {
      return { token: null };
    }
  } catch {
    return null;
  }
}

/** Кому шлём: личка (`user_id`) или чат (`chat_id`). */
export interface MaxSendTarget {
  kind: "direct" | "chat";
  id: number;
}

/**
 * Отправить сообщение со вложением, пережидая обработку файла на стороне MAX.
 *
 * `attachment.not.ready` — единственная ошибка, которую имеет смысл ждать:
 * файл загружен, но ещё обрабатывается. Остальные пробрасываются сразу.
 */
export async function sendWithAttachment(
  token: string,
  target: MaxSendTarget,
  text: string,
  attachment: { type: string; payload: { token: string } },
  waitsMs: readonly number[] = [0, 1500, 3000, 4500, 6000, 9000],
): Promise<string | null> {
  const params: Record<string, string | number> =
    target.kind === "direct" ? { user_id: target.id } : { chat_id: target.id };
  const body: Record<string, unknown> = { attachments: [attachment] };
  if (text) body.text = text;
  let lastError: unknown = null;
  for (const wait of waitsMs) {
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      const res = await maxRequest<{ message?: { body?: { mid?: string } } }>(
        token, "POST", "/messages", params, body
      );
      return res?.message?.body?.mid ?? null;
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("attachment.not.ready")) throw err;
    }
  }
  throw lastError ?? new Error("MAX attachment never became ready");
}
