/**
 * MAX channel plugin for OpenClaw.
 *
 * Supports two delivery modes:
 *  - Webhook (recommended for production): configure `channels.max.webhookUrl`
 *  - Long polling (default, works everywhere)
 *
 * MAX Bot API: https://dev.max.ru/docs-api
 */

import {
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk/core";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { buildOptionalSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";
import { describeMissingToken, listAccountIds, resolveAccount } from "./accounts.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { sendDm, sendToChat, sendDmWithImage, sendToChatWithImage, editMessage, markSeen, sendTypingAction, getUpdates, subscribeWebhook, deleteWebhook, getBotInfo, getUploadUrl, uploadFile, configureMaxTransport, createUpload, uploadToUrl, sendWithAttachment } from "./client.js";
import type { MaxSendTarget } from "./client.js";
import { resolveChannelPreviewStreamMode } from "openclaw/plugin-sdk/channel-outbound";
import {
  createMaxProgressDraft,
  type MaxProgressDraftMode,
  type MaxStreamingEntry,
} from "./progress-draft.js";
import { getMaxRuntime } from "./runtime.js";
import { createWebhookHandler, handleUpdate } from "./webhook-handler.js";
import type { InboundDelivery, InboundImage, ResolvedMaxAccount } from "./types.js";
import { isAbortError, isRetryableError, retryWithBackoff, runResilientPolling } from "./reconnect.js";

const CHANNEL_ID = "max";

/** Active typing-stop callbacks keyed by unique instance id — lets sendMedia stop all typing */
const activeTypingStops = new Map<string, () => void>();
let typingStopSeq = 0;

/**
 * Схема настроек канала.
 *
 * ⚠️ Приведение типа обязательно. Ядро держит свою копию zod (сейчас 4.5.4), а
 * плагин — свою; когда npm ставит их рядом, структурно одинаковые схемы
 * оказываются РАЗНЫМИ типами, и `tsc` спорит о внутренностях `$ZodCheck`
 * вплоть до `Type '5' is not assignable to type '6'`. Локально этого не видно:
 * там обе копии схлопываются в одну. Поймала проверка на двух версиях ядра.
 */
const MaxConfigSchema = buildChannelConfigSchema(
  z.object({
    // Строка или SecretRef `{ source, provider, id }`: ссылку разрешает ядро
    // (см. `secret-contract.ts`), до плагина доходит уже строка.
    token: buildOptionalSecretInputSchema().describe("MAX Bot API token (from business.max.ru), plain or SecretRef"),
    enabled: z.boolean().optional().default(true).describe("Enable or disable this channel"),
    dmPolicy: z.enum(["open", "allowlist", "closed"]).optional().default("allowlist").describe("Who can send DMs"),
    allowFrom: z.array(z.string()).optional().describe("Allowed MAX user IDs (when dmPolicy=allowlist)"),
    webhookUrl: z.string().optional().describe("Webhook URL for production mode (optional, uses long polling if not set)"),
    webhookSecret: z.string().optional().describe("Webhook secret for verifying MAX requests"),
  }).passthrough() as unknown as Parameters<typeof buildChannelConfigSchema>[0]
);

// Track active webhook route unregisters per account
const activeRouteUnregisters = new Map<string, () => void>();

function waitUntilAbort(signal?: AbortSignal, onAbort?: () => void): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { onAbort?.(); resolve(); };
    if (!signal) return;
    if (signal.aborted) { done(); return; }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Minimum interval between streaming edits (ms) to avoid rate limits */
const TYPING_INTERVAL_MS = 4000;
/** Leak guard only — reset on activity so long think/tool turns keep typing. */
const TYPING_SAFETY_MS = 30 * 60 * 1000;

/**
 * Send a reply to the user based on chat type.
 * Returns the message_id (for streaming edits).
 */
async function sendReply(
  account: ResolvedMaxAccount,
  chatId: string,
  chatType: string,
  text: string,
): Promise<string | null> {
  const numericId = parseInt(chatId, 10);
  if (isNaN(numericId)) return null;

  if (chatType === "direct") {
    return sendDm(account.token, numericId, text);
  } else {
    return sendToChat(account.token, numericId, text);
  }
}

function isSilentFinalText(text: unknown): boolean {
  const t = String(text ?? "").trim();
  return !t || t === "NO_REPLY" || t === "HEARTBEAT_OK";
}




/**
 * Create a streaming deliverer:
 * - onWorkStart / onStatus: visible activity before any answer tokens exist
 * - onPartialToken(text): called per streaming token → sends/edits message with cursor
 * - deliver(payload): called once at end with full text → final clean edit (no cursor)
 *
 * MAX Bot API typing (`POST /chats/{chatId}/actions`, action typing_on) is documented
 * for group chats and is ephemeral; DMs need an editable placeholder to stay alive.
 */
/**
 * Нагрузка одного ответа. Ядро кладёт сюда и текст, и медиа, и признак того,
 * что текст уже показан (голосовой довесок).
 */
interface DeliverPayload {
  text?: string;
  body?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  attachments?: Array<{
    mediaUrl?: string;
    url?: string;
    path?: string;
    filePath?: string;
    mimeType?: string;
  }>;
  ttsSupplement?: { spokenText?: string; visibleTextAlreadyDelivered?: boolean };
}

/**
 * Второй аргумент доставки. `kind` отличает промежуточный кусок работы от
 * ответа, и без него рассказ «сейчас посмотрю» затирает готовый ответ:
 * ядро отдаёт блоки не в том порядке, в каком они появляются в чате.
 */
interface DeliverInfo {
  kind?: string;
}

/** Одно вложение ответа, приведённое к тому, что нужно для отправки. */
interface OutboundMediaItem {
  ref: string;
  mimeType: string;
  name: string;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
};

const AUDIO_MIME_BY_EXT: Record<string, string> = {
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  aac: "audio/aac",
};

function inferOutboundMediaType(
  mimeType: string | undefined,
  filename: string | undefined,
  buffer: Buffer,
): "image" | "video" | "audio" | "file" {
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("video/")) return "video";
  if (mimeType?.startsWith("audio/")) return "audio";

  const ext = filename?.split(/[?#]/, 1)[0]?.split(".").pop()?.toLowerCase();
  if (ext && IMAGE_MIME_BY_EXT[ext]) return "image";
  if (ext && AUDIO_MIME_BY_EXT[ext]) return "audio";
  if (ext && ["mp4", "mov", "mkv", "webm", "avi"].includes(ext)) return "video";

  // OpenClaw's modern outbound bridge may provide a prepared Buffer without
  // mimeType/filename. Sniff common image signatures so valid images do not
  // fall through to MAX's generic-file upload flow.
  if (
    (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
    (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) ||
    (buffer.length >= 6 && (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a")) ||
    (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") ||
    (buffer.length >= 2 && buffer.subarray(0, 2).toString("ascii") === "BM")
  ) return "image";

  return "file";
}

/**
 * Собрать вложения ответа: ссылки из нагрузки плюс тип файла.
 *
 * Тип берётся из `attachments`, если ядро его сообщило, иначе по расширению.
 * Дубликаты (ядро кладёт одно и то же и в `mediaUrl`, и в `mediaUrls`) снимаются.
 */
export function collectOutboundMedia(payload: DeliverPayload): OutboundMediaItem[] {
  const refs = [payload?.mediaUrl, ...(Array.isArray(payload?.mediaUrls) ? payload.mediaUrls : [])];
  const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
  const seen = new Set<string>();
  const items: OutboundMediaItem[] = [];
  for (const ref of refs) {
    if (typeof ref !== "string" || !ref || seen.has(ref)) continue;
    seen.add(ref);
    const bare = ref.split("?")[0].split("#")[0];
    const attachment = attachments.find((a) =>
      [a?.mediaUrl, a?.url, a?.path, a?.filePath].includes(ref),
    );
    const ext = (bare.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "").toLowerCase();
    items.push({
      ref,
      mimeType: attachment?.mimeType ?? IMAGE_MIME_BY_EXT[ext] ?? AUDIO_MIME_BY_EXT[ext] ?? "",
      name: safeFileName(bare.split("/").pop() || "file"),
    });
  }
  return items;
}

/**
 * Имя файла для загрузчика.
 *
 * `decodeURIComponent` бросает `URIError` на одиночном проценте в имени, а
 * вызов стоит в самом начале доставки — вне защиты вокруг медиа. Такое имя
 * унесло бы весь ответ, а не одно вложение.
 */
function safeFileName(raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Keep the undecoded name when it contains an invalid percent escape.
  }
  // A URL basename can contain encoded separators. Do not let decoding turn it
  // back into a path or multipart filename with directory components.
  return decoded.replace(/[\\/]/g, "_");
}

/** Прочитать вложение только через проверенный OpenClaw media-access hook. */
async function readOutboundMedia(
  ref: string,
  mediaReadFile?: (filePath: string) => Promise<Buffer>,
): Promise<Buffer> {
  if (!mediaReadFile) {
    throw new Error("MAX outbound media requires OpenClaw mediaReadFile");
  }
  try {
    return Buffer.from(await mediaReadFile(ref));
  } catch {
    // Do not reflect signed URLs, local paths, request bodies or loader details.
    throw new Error("OpenClaw could not read outbound media for MAX");
  }
}

export function createStreamingDeliver(
  account: ResolvedMaxAccount,
  chatId: string,
  dialogChatId: string,
  chatType: string,
  entry: MaxStreamingEntry,
  mode: MaxProgressDraftMode,
  seed: string,
  log?: any,
  mediaReadFile?: (filePath: string) => Promise<Buffer>,
): {
  onPartialToken: (text: string) => Promise<void>;
  onWorkStart: () => Promise<void>;
  onThinking: () => Promise<void>;
  onToolStart: (payload: { name?: string; args?: unknown; phase?: string }) => Promise<void>;
  onItemEvent: (payload: {
    title?: string;
    summary?: string;
    progressText?: string;
    name?: string;
    phase?: string;
  }) => Promise<void>;
  onApprovalEvent: (payload: { phase?: string; title?: string }) => Promise<void>;
  deliver: (payload: DeliverPayload, info?: DeliverInfo) => Promise<void>;
  finish: () => Promise<void>;
} {
  // Живой поток — только при `streaming.mode: "partial"`.
  let accumulated = "";
  // Рассказ по ходу работы (`kind=block`) — копится отдельно от ответа: ядро
  // отдаёт куски не в том порядке, в каком их ждёшь, и раньше пришедший позже
  // рассказ затирал готовый ответ.
  let blockDraft = "";
  let answerDelivered = false;

  const draft = createMaxProgressDraft({ account, chatId, chatType, entry, mode, seed, log });

  // Typing indicator — MAX сбрасывает его на каждой правке сообщения.
  const numericDialogChatId = parseInt(dialogChatId, 10);
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  let safetyTimer: ReturnType<typeof setTimeout> | null = null;
  if (!isNaN(numericDialogChatId)) {
    // Вторая галка у сообщения собеседника: ставится один раз в начале хода.
    markSeen(account.token, numericDialogChatId).catch(() => {});
    sendTypingAction(account.token, numericDialogChatId).catch(() => {});
    typingInterval = setInterval(() => {
      sendTypingAction(account.token, numericDialogChatId).catch(() => {});
    }, TYPING_INTERVAL_MS);
  }

  // Unique key for this deliver instance (not chatId — concurrent messages share chatId)
  const instanceKey = String(++typingStopSeq);

  function armTypingSafety() {
    if (safetyTimer) clearTimeout(safetyTimer);
    safetyTimer = setTimeout(() => stopTyping(), TYPING_SAFETY_MS);
  }

  function stopTyping() {
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = null;
    }
    if (typingInterval) {
      clearInterval(typingInterval);
      typingInterval = null;
    }
    activeTypingStops.delete(instanceKey);
  }

  armTypingSafety();
  // Register so sendMedia can stop ALL active typing intervals
  activeTypingStops.set(instanceKey, stopTyping);

  function maxTarget(): MaxSendTarget {
    const numericId = parseInt(chatId, 10);
    if (isNaN(numericId)) throw new Error(`Invalid MAX chat id: ${chatId}`);
    return { kind: chatType === "direct" ? "direct" : "chat", id: numericId };
  }

  /** Картинки вложением; подпись уходит с первой. */
  async function sendOutboundImages(items: OutboundMediaItem[], caption: string) {
    const target = maxTarget();
    let text = caption;
    for (const item of items) {
      const buffer = await readOutboundMedia(item.ref, mediaReadFile);
      const uploadUrl = await getUploadUrl(account.token, "image");
      if (!uploadUrl) throw new Error("Failed to get MAX upload URL");
      const uploaded = await uploadFile(uploadUrl, buffer, item.mimeType || "image/jpeg", item.name);
      if (!uploaded) throw new Error("Failed to upload image to MAX");
      const mid =
        target.kind === "direct"
          ? await sendDmWithImage(account.token, target.id, text, uploaded.token)
          : await sendToChatWithImage(account.token, target.id, text, uploaded.token);
      // Отправка картинки глотает ошибку API и отдаёт null. Без этой проверки
      // в лог уходило бодрое «image sent mid=unknown», то есть датчик, ради
      // которого лог и заводили, на провале молчал.
      if (!mid) throw new Error("Failed to send MAX image");
      log?.info?.(`[openclaw-max] image sent mid=${mid} bytes=${buffer.length}`);
      text = "";
    }
  }

  /** Звук вложением: токен от `createUpload`, отправка с ожиданием обработки. */
  async function sendOutboundAudio(items: OutboundMediaItem[], caption: string) {
    const target = maxTarget();
    let text = caption;
    for (const item of items) {
      const buffer = await readOutboundMedia(item.ref, mediaReadFile);
      const upload = await createUpload(account.token, "audio");
      if (!upload) throw new Error("Failed to create MAX audio upload");
      const stored = await uploadToUrl(upload.url, buffer, item.mimeType || "audio/ogg", item.name);
      if (!stored) throw new Error("Failed to upload audio to MAX");
      const mid = await sendWithAttachment(account.token, target, text, {
        type: "audio",
        payload: { token: stored.token ?? upload.token },
      });
      log?.info?.(`[openclaw-max] audio sent mid=${mid ?? "unknown"} bytes=${buffer.length}`);
      text = "";
    }
  }

  /**
   * Отправить вложения ответа. Сбой не роняет ход: текст важнее вложения,
   * а строка в логе — единственный датчик (раньше медиа терялось молча).
   */
  async function sendOutboundMedia(
    images: OutboundMediaItem[],
    audios: OutboundMediaItem[],
    caption: string,
  ): Promise<boolean> {
    try {
      if (images.length > 0) {
        await sendOutboundImages(images, caption);
        caption = "";
      }
      if (audios.length > 0) await sendOutboundAudio(audios, caption);
      return true;
    } catch (err) {
      log?.error?.(
        `[openclaw-max] вложение отправить не удалось: ${err instanceof Error ? err.message : err}`,
      );
      return false;
    }
  }

  let placeholderShown = false;

  /**
   * Ход начался: показать метку, пока шагов ещё нет.
   *
   * Ядро зовёт это не раз за ход, а каждые несколько секунд, пока держит
   * индикатор набора. Раньше каждый тик переписывал черновик мимо компоновщика
   * и затирал уже нарисованный список шагов одной меткой.
   */
  async function onWorkStart() {
    armTypingSafety();
    if (placeholderShown) return;
    placeholderShown = true;
    await draft.showPlaceholder();
  }

  async function onThinking() {
    armTypingSafety();
    await draft.compositor.pushReasoningProgress("думаю…");
  }

  async function onToolStart(payload: { name?: string; args?: unknown; phase?: string }) {
    const name = typeof payload?.name === "string" ? payload.name.trim() : "";
    if (!name) return;
    armTypingSafety();
    await draft.compositor.pushToolEvent({
      name,
      phase: payload?.phase,
      args: (payload?.args ?? undefined) as Record<string, unknown> | undefined,
    });
  }

  async function onItemEvent(payload: {
    title?: string;
    summary?: string;
    progressText?: string;
    name?: string;
    phase?: string;
  }) {
    armTypingSafety();
    await draft.compositor.pushItemEvent({
      title: payload?.title,
      summary: payload?.summary,
      progressText: payload?.progressText,
      name: payload?.name,
      phase: payload?.phase,
    });
  }

  async function onApprovalEvent(payload: { phase?: string; title?: string }) {
    if (payload?.phase && payload.phase !== "requested") return;
    armTypingSafety();
    await draft.compositor.pushApprovalEvent({ phase: payload?.phase, title: payload?.title });
  }

  /** Живой поток текста — только при `streaming.mode: "partial"`. */
  async function onPartialToken(text: string) {
    if (!text) return;
    armTypingSafety();
    accumulated = text; // SET not += (onPartialReply is cumulative)
    await draft.overwrite(`${accumulated} …`);
  }

  /** Отдать ответ: переписать черновик на месте либо послать новым сообщением. */
  async function publishAnswer(text: string): Promise<void> {
    const draftId = draft.currentMessageId();
    draft.compositor.markFinalReplyStarted();
    if (draftId) {
      // Черновик становится ответом — без метки и без списка шагов.
      const ok = await editMessage(account.token, draftId, text);
      if (ok) {
        // Забываем сообщение: оно больше не черновик, а ответ. Иначе поздний
        // приход уведёт его в `remove()` — так в ВК исчез текст у собеседника.
        draft.detach();
        answerDelivered = true;
        log?.info?.(`[openclaw-max] answer in draft mid=${draftId} chars=${text.length}`);
        return;
      }
      draft.close();
      // Правка не прошла (окно закрылось, сообщение удалили) — шлём заново.
      await draft.remove();
    } else {
      draft.close();
    }
    const mid = await sendReply(account, chatId, chatType, text);
    answerDelivered = true;
    log?.info?.(`[openclaw-max] answer sent mid=${mid ?? "unknown"} chars=${text.length}`);
  }

  /**
   * Один кусок ответа от ядра.
   *
   * `info.kind` отличает промежуточный рассказ (`block`) от ответа (`final`).
   * Без него плагин писал в одно сообщение и то и другое: рассказ приходил
   * после готового ответа и затирал его (лог 22.09.2026, ход 13:18 — 171
   * символ «Посмотрю, есть ли датчик…» поверх 687 символов ответа).
   *
   * Финал с `visibleTextAlreadyDelivered` — не ответ, а голос к уже показанному
   * тексту: трогать текст ему нельзя. В ВК пропуск этой проверки 08.09.2026
   * удалил сообщение с ответом.
   */
  async function deliver(payload: DeliverPayload, info?: DeliverInfo) {
    // В черновик уходит только рассказ по ходу работы. Всё прочее (`final`,
    // долговечные результаты инструментов, неизвестные виды) доставляется:
    // спрятать в черновик, скажем, запрос подтверждения — значит отчитаться
    // ядру о доставке и не показать вопрос собеседнику.
    const isFinal = (info?.kind ?? "final") !== "block";
    const isTtsSupplement =
      isFinal && payload?.ttsSupplement?.visibleTextAlreadyDelivered === true;
    const rawText = payload?.text ?? payload?.body ?? accumulated;
    const media = collectOutboundMedia(payload);
    const images = media.filter((item) => item.mimeType.startsWith("image/"));
    const audios = media.filter((item) => item.mimeType.startsWith("audio/"));
    for (const item of media) {
      if (!images.includes(item) && !audios.includes(item)) {
        log?.info?.(
          `[openclaw-max] вложение пропущено, MAX принимает картинку и звук: ${item.name} (${item.mimeType || "тип неизвестен"})`,
        );
      }
    }
    const hasMedia = images.length > 0 || audios.length > 0;

    // ── Промежуточный кусок: в черновик хода, не в ответ ────────────────────
    if (!isFinal) {
      const chunk = String(rawText ?? "").trim();
      if (chunk && !isSilentFinalText(chunk)) {
        blockDraft = blockDraft ? `${blockDraft}\n\n${chunk}` : chunk;
        await draft.compositor.pushNarrationProgress(chunk);
      }
      // Вложение в черновик не положить — отправляем сразу, отдельным сообщением.
      if (hasMedia) await sendOutboundMedia(images, audios, "");
      return;
    }

    stopTyping(); // Ensure typing stops even if no partial tokens came

    // ── Голосовой довесок: несёт только звук, текст уже показан ─────────────
    if (isTtsSupplement) {
      // «Уже показан» — со стороны ядра. У нас куски `block` только копятся в
      // черновике и наружу не уходят, поэтому при озвучке финала собеседник
      // получил бы голос и ни строчки текста, а `finish` ещё и стёр бы черновик.
      if (!answerDelivered) {
        const spoken = payload?.ttsSupplement?.spokenText ?? "";
        const text = blockDraft || String(rawText ?? "") || spoken;
        if (text.trim()) await publishAnswer(text);
      }
      await sendOutboundMedia(images, audios, "");
      return;
    }

    // Пустой финал: ответом становится то, что успело прийти кусками.
    const finalText = isSilentFinalText(rawText) ? accumulated || blockDraft : rawText;
    if (!finalText && !hasMedia) {
      // Отвечать нечем — черновик убираем, чтобы не висел «работаю».
      draft.close();
      await draft.remove();
      return;
    }
    if (finalText) {
      await publishAnswer(finalText);
    } else {
      // Одно вложение без текста: черновик не нужен.
      draft.close();
      await draft.remove();
    }
    if (hasMedia) {
      // Текст уже ушёл сообщением — подпись только если его не было.
      // Текст ушёл своим сообщением, поэтому подписи у вложения нет.
      await sendOutboundMedia(images, audios, "");
    }
  }

  async function finish() {
    stopTyping();
    draft.compositor.markFinalReplyDelivered();
    draft.close();
    if (!answerDelivered) {
      // Ход кончился, а ответа не было: черновик остался бы висеть навсегда.
      await draft.remove();
    }
  }

  return {
    onPartialToken,
    onWorkStart,
    onThinking,
    onToolStart,
    onItemEvent,
    onApprovalEvent,
    deliver,
    finish,
  };
}

/**
 * Dispatch an inbound message to the OpenClaw agent and send reply back.
 */
export async function deliverMessage(
  {
    text,
    senderId,
    senderName,
    chatId,
    dialogChatId,
    chatType,
    messageId: _messageId,
    accountId,
    images,
  }: {
    text: string;
    senderId: string;
    senderName: string;
    chatId: string;
    dialogChatId: string;
    chatType: string;
    messageId: string; // bound as _messageId (unused but part of interface)
    accountId: string;
    images?: InboundImage[];
  },
  account: ResolvedMaxAccount,
  cfg: unknown,
  log?: any,
): Promise<void> {
  const rt = getMaxRuntime();
  const route = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId,
    peer: { kind: chatType === "direct" ? "direct" : "group", id: senderId },
  });
  const sessionKey = route.sessionKey;

  const msgCtx = rt.channel.reply.finalizeInboundContext({
    Body: text,
    RawBody: text,
    CommandBody: text,
    From: `max:${senderId}`,
    To: `max:${senderId}`,
    SessionKey: sessionKey,
    AccountId: accountId,
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: `max:${senderId}`,
    ChatType: chatType === "direct" ? "direct" : "group",
    SenderName: senderName,
    SenderId: senderId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    ConversationLabel: senderName || senderId,
    Timestamp: Date.now(),
    CommandAuthorized: true,
  });

  // Черновик хода ведётся по общим для каналов настройкам `channels.max.streaming`.
  // Умолчание — "progress", как у Telegram и ВК: шаги живут в одном сообщении,
  // посимвольный поток не подписывается вовсе (именно он затирал черновик).
  const entry = (cfg as { channels?: Record<string, unknown> } | undefined)?.channels?.[
    CHANNEL_ID
  ] as MaxStreamingEntry;
  const streamMode = resolveChannelPreviewStreamMode(entry, "progress") as MaxProgressDraftMode;
  const mediaReadFile = async (filePath: string): Promise<Buffer> =>
    Buffer.from(
      (
        await rt.media.loadWebMedia(filePath, {
          // Reply media was authorized by the core turn that produced it;
          // keep the read itself inside OpenClaw's media runtime.
          localRoots: "any",
        })
      ).buffer,
    );
  const { onPartialToken, onWorkStart, onThinking, onToolStart, onItemEvent, onApprovalEvent, deliver, finish } =
    createStreamingDeliver(
      account,
      chatId,
      dialogChatId,
      chatType,
      entry,
      streamMode,
      `${chatId}:${_messageId}`,
      log,
      mediaReadFile,
    );

  try {
    await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: msgCtx,
      cfg,
      dispatcherOptions: {
        deliver,
        // Ядро зовёт `onReplyStart` не раз за ход, а каждые ~5 секунд, пока
        // идёт работа: в логе выходило 27 строк на два сообщения за час.
        // Плашку обновляем как прежде, а пишем один раз.
        onReplyStart: (() => {
          let announced = false;
          return () => {
            if (!announced) {
              announced = true;
              log?.info?.(`[openclaw-max] Agent reply started for ${senderName}`);
            }
            return onWorkStart();
          };
        })(),
      },
      replyOptions: {
        suppressDefaultToolProgressMessages: true,
        preserveProgressCallbackStartOrder: true,
        // Посимвольный поток подписывается только при `streaming.mode: "partial"`.
        // В режимах "progress"/"block" он затирал бы черновик хода — из-за него
        // статус пропадал на середине хода (лог 22.09.2026, ход 13:18).
        ...(streamMode === "partial"
          ? {
              onPartialReply: async (payload: { text?: string }) => {
                if (payload?.text) await onPartialToken(payload.text);
              },
            }
          : {}),
        onReasoningStream: async () => {
          await onThinking();
        },
        onToolStart: async (payload: { name?: string; args?: unknown }) => {
          await onToolStart(payload);
        },
        onItemEvent: async (payload: {
          title?: string;
          summary?: string;
          progressText?: string;
          name?: string;
        }) => {
          await onItemEvent(payload);
        },
        onApprovalEvent: async (payload: { phase?: string; title?: string }) => {
          await onApprovalEvent(payload);
        },
        images: images?.map(img => ({
          type: "image" as const,
          mimeType: img.mimeType,
          data: img.data,
        })),
      },
    });
  } finally {
    await finish();
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function createMaxPlugin(): any {
  return {
    id: CHANNEL_ID,

    meta: {
      id: CHANNEL_ID,
      label: "MAX",
      selectionLabel: "MAX (Bot API)",
      detailLabel: "MAX Bot",
      docsPath: "/channels/max",
      docsLabel: "max",
      blurb: "Connect OpenClaw to MAX messenger (max.ru) via Bot API.",
      order: 80,
    },

    capabilities: {
      chatTypes: ["direct" as const, "group" as const],
      media: true,
      threads: false,
      reactions: false,
      edit: false,
      unsend: false,
      reply: false,
      effects: false,
      blockStreaming: false,
    },

    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },

    configSchema: MaxConfigSchema,

    secrets: {
      secretTargetRegistryEntries,
      collectRuntimeConfigAssignments,
    },

    config: {
      listAccountIds: (cfg: any) => listAccountIds(cfg),
      resolveAccount: (cfg: any, accountId?: string | null) => resolveAccount(cfg, accountId),
      defaultAccountId: (_cfg: any) => DEFAULT_ACCOUNT_ID,

      setAccountEnabled: ({ cfg, accountId, enabled }: any) => {
        const channelConfig = cfg?.channels?.[CHANNEL_ID] ?? {};
        if (accountId === DEFAULT_ACCOUNT_ID) {
          return {
            ...cfg,
            channels: { ...cfg.channels, [CHANNEL_ID]: { ...channelConfig, enabled } },
          };
        }
        return setAccountEnabledInConfigSection({
          cfg,
          sectionKey: `channels.${CHANNEL_ID}`,
          accountId,
          enabled,
        });
      },
    },

    pairing: {
      idLabel: "maxUserId",
      // Сначала обрезка, потом префикс: запись с ведущим пробелом
      // (« max:user:42») иначе остаётся с префиксом и не совпадает с
      // отправителем. В `normalizeAllowFrom` порядок как раз правильный.
      normalizeAllowEntry: (entry: string) => entry.trim().replace(/^max:(?:user:)?/i, "").trim(),
      notifyApproval: async ({ cfg, id }: { cfg: any; id: string }) => {
        const account = resolveAccount(cfg);
        if (!account.token) return;
        const numericId = parseInt(id, 10);
        if (!isNaN(numericId)) {
          await sendDm(account.token, numericId, "✅ OpenClaw: your access has been approved.");
        }
      },
    },

    security: {
      resolveDmPolicy: ({ cfg, accountId, account: resolvedAccount }: any) => {
        const account: ResolvedMaxAccount = resolvedAccount ?? resolveAccount(cfg, accountId);
        return {
          policy: account.dmPolicy,
          allowFrom: account.allowFrom,
          policyPath: `channels.max.dmPolicy`,
          allowFromPath: `channels.max.allowFrom`,
          approveHint: "openclaw pairing approve max <code>",
        };
      },
    },

    directory: {
      self: async () => null,
      listPeers: async () => [],
      listGroups: async () => [],
    },

    outbound: {
      deliveryMode: "gateway" as const,
      textChunkLimit: 4000,

      sendText: async ({ to, text, accountId, cfg }: any) => {
        const account = resolveAccount(cfg ?? {}, accountId);
        if (!account.token) throw new Error(describeMissingToken(account));

        const numericId = parseInt(to.replace(/^max:(?:user:)?/i, ""), 10);
        if (isNaN(numericId)) throw new Error(`Invalid MAX user ID: ${to}`);

        const ok = await sendDm(account.token, numericId, text);
        if (!ok) throw new Error("Failed to send MAX message");
        return { channel: CHANNEL_ID, messageId: `max-${Date.now()}`, chatId: to };
      },

      sendMedia: async ({
        to,
        buffer,
        mediaUrl,
        mediaReadFile,
        mimeType,
        filename,
        caption,
        text: outboundText,
        accountId,
        cfg,
        chatType,
      }: any) => {
        const account = resolveAccount(cfg ?? {}, accountId);
        if (!account.token) throw new Error(describeMissingToken(account));

        const numericId = parseInt(to.replace(/^max:(?:user:)?/i, ""), 10);
        if (isNaN(numericId)) throw new Error(`Invalid MAX user ID: ${to}`);

        // Current OpenClaw gives outbound adapters `mediaUrl`; older bridges
        // and focused tests may provide an already prepared `buffer`.
        const mediaBuffer = Buffer.isBuffer(buffer)
          ? buffer
          : typeof mediaUrl === "string" && mediaUrl
            ? await readOutboundMedia(mediaUrl, mediaReadFile)
            : null;
        if (!mediaBuffer) throw new Error("MAX media payload is missing");

        const inferredFilename = filename ?? (typeof mediaUrl === "string"
          ? safeFileName(mediaUrl.split(/[?#]/, 1)[0]?.split("/").pop() || "file")
          : "file");

        // Determine media type
        const mediaType = inferOutboundMediaType(mimeType, inferredFilename, mediaBuffer);

        const text = caption ?? outboundText ?? "";
        let mid: string | null = null;
        if (mediaType === "image") {
          // Для картинки токен вложения отдаёт сам загрузчик.
          const uploadUrl = await getUploadUrl(account.token, "image");
          if (!uploadUrl) throw new Error("Failed to get MAX upload URL");
          const uploaded = await uploadFile(
            uploadUrl,
            mediaBuffer,
            mimeType ?? "application/octet-stream",
            inferredFilename,
          );
          if (!uploaded) throw new Error("Failed to upload file to MAX");
          if (chatType === "direct" || !chatType) {
            mid = await sendDmWithImage(account.token, numericId, text, uploaded.token);
          } else {
            mid = await sendToChatWithImage(account.token, numericId, text, uploaded.token);
          }
        } else {
          // Всё остальное MAX тоже принимает вложением (audio, video, file), но
          // токен берётся у `POST /uploads`, а не у загрузчика, и сразу после
          // загрузки приходит `attachment.not.ready`. Раньше здесь был откат в
          // текст с подписью: голос и документы до собеседника не доходили.
          const upload = await createUpload(account.token, mediaType);
          if (!upload) throw new Error("Failed to create MAX upload");
          const stored = await uploadToUrl(
            upload.url,
            mediaBuffer,
            mimeType ?? "application/octet-stream",
            inferredFilename,
          );
          if (!stored) throw new Error("Failed to upload file to MAX");
          mid = await sendWithAttachment(
            account.token,
            { kind: chatType === "direct" || !chatType ? "direct" : "chat", id: numericId },
            text,
            { type: mediaType, payload: { token: stored.token ?? upload.token } },
          );
        }

        // Stop ALL active typing indicators — deliver() may not be called after sendMedia
        for (const stopFn of activeTypingStops.values()) stopFn();
        activeTypingStops.clear();

        return { channel: CHANNEL_ID, messageId: mid ?? `max-${Date.now()}`, chatId: to };
      },
    },

    gateway: {
      startAccount: async (ctx: any) => {
        const { cfg, accountId, log } = ctx;
        const account = resolveAccount(cfg, accountId);

        if (!account.enabled) {
          log?.info?.(`[openclaw-max] Account ${accountId} disabled, skipping`);
          return waitUntilAbort(ctx.abortSignal);
        }

        if (account.tokenUnresolved) {
          log?.error?.(`[openclaw-max] Account ${accountId}: ${describeMissingToken(account)}, not starting`);
          return waitUntilAbort(ctx.abortSignal);
        }

        if (!account.token) {
          log?.warn?.(`[openclaw-max] Account ${accountId} missing token, skipping`);
          return waitUntilAbort(ctx.abortSignal);
        }

        // Configure the HTTP transport (Минцифры CA + optional proxy) before any
        // API call. Note: the transport is process-global, so with multiple
        // accounts the last-started account's proxy wins; the CA trust is shared.
        configureMaxTransport({ httpProxy: account.httpProxy });
        if (account.httpProxy) {
          log?.info?.(`[openclaw-max] Using HTTP proxy for MAX API traffic`);
        }

        try {
          const info = await retryWithBackoff(() => getBotInfo(account.token, ctx.abortSignal), {
            signal: ctx.abortSignal,
            isRetryable: isRetryableError,
            onRetry: (_err, attempt, delayMs) => log?.warn?.(
              `[openclaw-max] Connection lost during token verification; retry ${attempt} in ${delayMs}ms`,
            ),
          });
          log?.info?.(`[openclaw-max] Connected as bot: ${info.name} (@${info.username})`);
        } catch (err) {
          if (ctx.abortSignal?.aborted || isAbortError(err)) return;
          log?.error?.(`[openclaw-max] Token verification failed: ${err instanceof Error ? err.message : err}`);
          return waitUntilAbort(ctx.abortSignal);
        }

        if (account.webhookUrl) {
          return startWebhookMode(ctx, account, cfg, log);
        } else {
          return startLongPollingMode(ctx, account, cfg, log);
        }
      },

      stopAccount: async (ctx: any) => {
        ctx.log?.info?.(`[openclaw-max] Account ${ctx.accountId} stopped`);
      },
    },

    heartbeat: {
      sendTyping: async ({ cfg, to, accountId }: { cfg?: any; to: string; accountId?: string }) => {
        const account = resolveAccount(cfg ?? {}, accountId);
        if (!account.token) return;
        const numericId = parseInt(String(to).replace(/^max:(?:user:)?/i, ""), 10);
        if (isNaN(numericId)) return;
        await sendTypingAction(account.token, numericId);
      },
    },

    agentPrompt: {
      messageToolHints: () => [
        "",
        "### MAX Messenger Formatting",
        "MAX supports Markdown formatting:",
        "",
        "- **bold**: `**text**` or `__text__`",
        "- *italic*: `*text*` or `_text_`",
        "- ~~strikethrough~~: `~~text~~`",
        "- `inline code`: backtick",
        "- [links](url): `[display text](https://url)`",
        "",
        "Keep messages under 4000 characters.",
        "No emoji reactions, no message editing after send.",
      ],
    },
  };
}

// ─── Webhook mode ─────────────────────────────────────────────────────────────

async function startWebhookMode(ctx: any, account: ResolvedMaxAccount, _cfg: unknown, log: any) {
  log?.info?.(`[openclaw-max] Starting in webhook mode → ${account.webhookUrl}`);

  // Register webhook with MAX
  try {
    await subscribeWebhook(account.token, account.webhookUrl!, account.webhookSecret);
    log?.info?.(`[openclaw-max] Webhook registered: ${account.webhookUrl}`);
  } catch (err) {
    log?.error?.(`[openclaw-max] Failed to register webhook: ${err instanceof Error ? err.message : err}`);
    return waitUntilAbort(ctx.abortSignal);
  }

  const handler = createWebhookHandler({
    account,
    deliver: async (msg: InboundDelivery) => {
      const currentCfg = _cfg;
      await deliverMessage(msg, account, currentCfg, log);
      return null;
    },
    log,
  });

  const routeKey = `${account.accountId}:${account.webhookPath}`;
  const prev = activeRouteUnregisters.get(routeKey);
  if (prev) {
    log?.info?.(`[openclaw-max] Deregistering stale webhook route`);
    prev();
    activeRouteUnregisters.delete(routeKey);
  }

  const unregister = registerPluginHttpRoute({
    path: account.webhookPath,
    auth: "plugin",
    replaceExisting: true,
    pluginId: CHANNEL_ID,
    accountId: account.accountId,
    log: (msg: string) => log?.info?.(msg),
    handler,
  });
  activeRouteUnregisters.set(routeKey, unregister);
  log?.info?.(`[openclaw-max] Webhook route registered: ${account.webhookPath}`);

  return waitUntilAbort(ctx.abortSignal, async () => {
    log?.info?.(`[openclaw-max] Stopping webhook mode for account ${account.accountId}`);
    unregister?.();
    activeRouteUnregisters.delete(routeKey);
    try {
      await deleteWebhook(account.token);
    } catch {
      // best-effort cleanup
    }
  });
}

// ─── Long polling mode ────────────────────────────────────────────────────────

async function startLongPollingMode(ctx: any, account: ResolvedMaxAccount, cfg: unknown, log: any) {
  log?.info?.(`[openclaw-max] Starting in long polling mode`);
  const signal: AbortSignal = ctx.abortSignal;
  let marker: number | null | undefined = undefined;
  const updateRetryAttempts = 3;

  await runResilientPolling({
    signal,
    isRetryable: isRetryableError,
    poll: () => getUpdates(account.token, marker, 30, signal),
    onResult: async (result) => {
      if (result.updates.length > 0) {
        log?.info?.(`[openclaw-max] Received ${result.updates.length} update(s)`);
      }
      for (const update of result.updates ?? []) {
        if (signal?.aborted) return;
        try {
          await retryWithBackoff(
            () => handleUpdate(
              update,
              account,
              async (msg: InboundDelivery) => {
                await deliverMessage(msg, account, cfg, log);
                return null;
              },
              log,
            ),
            {
            signal,
            maxAttempts: updateRetryAttempts,
            isRetryable: () => true,
            baseDelayMs: 250,
            maxDelayMs: 2_000,
              onRetry: (error, attempt, delayMs) => log?.warn?.(
                `[openclaw-max] MAX update processing failed; retry ${attempt}/${updateRetryAttempts - 1} in ${delayMs}ms: ${String(error)}`,
              ),
            },
          );
        } catch (error) {
          if (signal?.aborted) return;
          log?.error?.(
            `[openclaw-max] Failed to process MAX update after ${updateRetryAttempts} attempts; marker not advanced: ${String(error)}`,
          );
          throw error;
        }
      }
      // Commit only after the complete batch succeeds. On exhaustion, MAX can
      // redeliver it; already completed updates may therefore be duplicated.
      if (result.marker != null) marker = result.marker;
    },
    onConnectionLost: () => log?.warn?.(`[openclaw-max] MAX connection lost; retrying long polling`),
    onConnectionRestored: () => log?.info?.(`[openclaw-max] MAX connection restored`),
  });
  log?.info?.(`[openclaw-max] Long polling stopped for account ${account.accountId}`);
}
