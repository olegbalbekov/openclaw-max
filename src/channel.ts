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
  registerPluginHttpRoute,
} from "openclaw/plugin-sdk/synology-chat";
import { z } from "zod";
import { listAccountIds, resolveAccount } from "./accounts.js";
import { sendDm, sendToChat, sendDmWithImage, sendToChatWithImage, editMessage, sendTypingAction, getUpdates, subscribeWebhook, deleteWebhook, getBotInfo, getUploadUrl, uploadFile } from "./client.js";
import { getMaxRuntime } from "./runtime.js";
import { createWebhookHandler, handleUpdate } from "./webhook-handler.js";
import type { InboundImage } from "./webhook-handler.js";
import type { ResolvedMaxAccount } from "./types.js";

const CHANNEL_ID = "max";

/** Active typing-stop callbacks keyed by unique instance id — lets sendMedia stop all typing */
const activeTypingStops = new Map<string, () => void>();
let typingStopSeq = 0;

const MaxConfigSchema = buildChannelConfigSchema(
  z.object({
    token: z.string().optional().describe("MAX Bot API token (from business.max.ru)"),
    enabled: z.boolean().optional().default(true).describe("Enable or disable this channel"),
    dmPolicy: z.enum(["open", "allowlist", "closed"]).optional().default("allowlist").describe("Who can send DMs"),
    allowFrom: z.array(z.string()).optional().describe("Allowed MAX user IDs (when dmPolicy=allowlist)"),
    webhookUrl: z.string().optional().describe("Webhook URL for production mode (optional, uses long polling if not set)"),
    webhookSecret: z.string().optional().describe("Webhook secret for verifying MAX requests"),
  }).passthrough()
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
const STREAM_EDIT_INTERVAL_MS = 800;

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

/**
 * Create a streaming deliverer:
 * - onPartialToken(text): called per streaming token → sends/edits message with ▌ cursor
 * - deliver(payload): called once at end with full text → final clean edit (no cursor)
 */
function createStreamingDeliver(
  account: ResolvedMaxAccount,
  chatId: string,
  dialogChatId: string,
  chatType: string,
  log?: any,
): {
  onPartialToken: (text: string) => Promise<void>;
  deliver: (payload: { text?: string; body?: string }) => Promise<void>;
} {
  let messageId: string | null = null;
  let accumulated = "";
  let lastEditAt = 0;
  let pendingEdit: ReturnType<typeof setTimeout> | null = null;

  // Typing indicator — declared early so throttledEdit can reference it
  const numericDialogChatId = parseInt(dialogChatId, 10);
  let typingInterval: ReturnType<typeof setInterval> | null = null;
  if (!isNaN(numericDialogChatId)) {
    sendTypingAction(account.token, numericDialogChatId).catch(() => {});
    typingInterval = setInterval(() => {
      sendTypingAction(account.token, numericDialogChatId).catch(() => {});
    }, 4000);
  }

  // Unique key for this deliver instance (not chatId — concurrent messages share chatId)
  const instanceKey = String(++typingStopSeq);

  // Safety timeout — stop typing after 90s even if deliver() is never called
  const safetyTimer = setTimeout(() => stopTyping(), 90_000);

  function stopTyping() {
    clearTimeout(safetyTimer);
    if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
    activeTypingStops.delete(instanceKey);
  }

  // Register so sendMedia can stop ALL active typing intervals
  activeTypingStops.set(instanceKey, stopTyping);

  async function throttledEdit(text: string) {
    if (!messageId) return;
    const elapsed = Date.now() - lastEditAt;
    if (pendingEdit) clearTimeout(pendingEdit);
    if (elapsed >= STREAM_EDIT_INTERVAL_MS) {
      await editMessage(account.token, messageId, text);
      lastEditAt = Date.now();
      // MAX clears typing on message edit — renew immediately after
      if (typingInterval !== null) {
        sendTypingAction(account.token, numericDialogChatId).catch(() => {});
      }
    } else {
      pendingEdit = setTimeout(async () => {
        if (messageId) {
          await editMessage(account.token, messageId, text).catch(() => {});
          lastEditAt = Date.now();
          if (typingInterval !== null) {
            sendTypingAction(account.token, numericDialogChatId).catch(() => {});
          }
        }
      }, STREAM_EDIT_INTERVAL_MS - elapsed) as unknown as ReturnType<typeof setTimeout>;
    }
  }

    // Promise to prevent race condition on first message creation
  let creationPromise: Promise<void> | null = null;

  // Called for each streaming partial (text is CUMULATIVE — full text so far)
  async function onPartialToken(text: string) {
    if (!text) return;
    // Keep typing indicator alive during streaming — stop only in deliver()
    accumulated = text; // SET not += (onPartialReply is cumulative)

    if (!messageId) {
      if (!creationPromise) {
        // First call: create message, lock against concurrent calls
        creationPromise = (async () => {
          messageId = await sendReply(account, chatId, chatType, accumulated + " …");
          lastEditAt = Date.now();
          log?.info?.(`[openclaw-max] Streaming started mid=${messageId}`);
        })();
      }
      await creationPromise;
      return;
    }

    await throttledEdit(accumulated + " …");
  }

  // Called once at end with final authoritative text
  async function deliver(payload: { text?: string; body?: string }) {
    stopTyping(); // Ensure typing stops even if no partial tokens came
    if (pendingEdit) { clearTimeout(pendingEdit); pendingEdit = null; }
    const finalText = payload?.text ?? payload?.body ?? accumulated;
    if (!finalText) return;

    if (messageId) {
      // Edit existing streamed message — remove cursor, use final text
      await editMessage(account.token, messageId, finalText);
    } else {
      // No partial tokens came through — send fresh
      await sendReply(account, chatId, chatType, finalText);
    }
  }

  return { onPartialToken, deliver };
}

/**
 * Dispatch an inbound message to the OpenClaw agent and send reply back.
 */
async function deliverMessage(
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
  const sessionKey = `max:${senderId}`;

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

  const { onPartialToken, deliver } = createStreamingDeliver(account, chatId, dialogChatId, chatType, log);

  await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: msgCtx,
    cfg,
    dispatcherOptions: {
      deliver,
      onReplyStart: () => {
        log?.info?.(`[openclaw-max] Agent reply started for ${senderName}`);
      },
    },
    replyOptions: {
      onPartialReply: async (payload: { text?: string }) => {
        if (payload?.text) await onPartialToken(payload.text);
      },
      images: images?.map(img => ({
        type: "image" as const,
        mimeType: img.mimeType,
        data: img.data,
      })),
    },
  });
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
      normalizeAllowEntry: (entry: string) => entry.replace(/^max:(?:user:)?/i, "").trim(),
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
        if (!account.token) throw new Error("MAX token not configured");

        const numericId = parseInt(to.replace(/^max:(?:user:)?/i, ""), 10);
        if (isNaN(numericId)) throw new Error(`Invalid MAX user ID: ${to}`);

        const ok = await sendDm(account.token, numericId, text);
        if (!ok) throw new Error("Failed to send MAX message");
        return { channel: CHANNEL_ID, messageId: `max-${Date.now()}`, chatId: to };
      },

      sendMedia: async ({ to, buffer, mimeType, filename, caption, accountId, cfg, chatType }: any) => {
        const account = resolveAccount(cfg ?? {}, accountId);
        if (!account.token) throw new Error("MAX token not configured");

        const numericId = parseInt(to.replace(/^max:(?:user:)?/i, ""), 10);
        if (isNaN(numericId)) throw new Error(`Invalid MAX user ID: ${to}`);

        // Determine media type
        const mediaType = mimeType?.startsWith("image/") ? "image"
          : mimeType?.startsWith("video/") ? "video"
          : mimeType?.startsWith("audio/") ? "audio"
          : "file";

        // Get upload URL
        const uploadUrl = await getUploadUrl(account.token, mediaType as "image" | "video" | "audio" | "file");
        if (!uploadUrl) throw new Error("Failed to get MAX upload URL");

        // Upload file
        const uploaded = await uploadFile(uploadUrl, buffer, mimeType ?? "application/octet-stream", filename ?? "file");
        if (!uploaded) throw new Error("Failed to upload file to MAX");

        // Send message with attachment
        const text = caption ?? "";
        let mid: string | null = null;
        if (mediaType === "image") {
          if (chatType === "direct" || !chatType) {
            mid = await sendDmWithImage(account.token, numericId, text, uploaded.token);
          } else {
            mid = await sendToChatWithImage(account.token, numericId, text, uploaded.token);
          }
        } else {
          // For non-image media, fall back to text with caption
          if (text) {
            mid = await sendDm(account.token, numericId, text);
          }
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

        if (!account.token) {
          log?.warn?.(`[openclaw-max] Account ${accountId} missing token, skipping`);
          return waitUntilAbort(ctx.abortSignal);
        }

        // Verify token on startup
        try {
          const info = await getBotInfo(account.token);
          log?.info?.(`[openclaw-max] Connected as bot: ${info.name} (@${info.username})`);
        } catch (err) {
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
    deliver: async (msg) => {
      const currentCfg = await getMaxRuntime().config.loadConfig();
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

async function startLongPollingMode(ctx: any, account: ResolvedMaxAccount, _cfg: unknown, log: any) {
  log?.info?.(`[openclaw-max] Starting in long polling mode`);

  const signal: AbortSignal = ctx.abortSignal;
  let marker: number | null | undefined = undefined;
  let consecutiveErrors = 0;
  const MAX_ERRORS = 5;

  while (!signal?.aborted) {
    try {
      const result = await getUpdates(account.token, marker, 30, signal);
      consecutiveErrors = 0;

      if (result.updates.length > 0) {
        log?.info?.(`[openclaw-max] Received ${result.updates.length} update(s)`);
        const currentCfg = await getMaxRuntime().config.loadConfig();

        for (const update of result.updates) {
          await handleUpdate(
            update,
            account,
            async (msg) => {
              await deliverMessage(msg, account, currentCfg, log);
              return null;
            },
            log,
          );
        }
      }

      // Advance marker
      if (result.marker != null) {
        marker = result.marker;
      }
    } catch (err) {
      if (signal?.aborted) break;
      consecutiveErrors++;
      const errMsg = err instanceof Error ? err.message : String(err);
      log?.warn?.(`[openclaw-max] Long polling error (${consecutiveErrors}/${MAX_ERRORS}): ${errMsg}`);

      if (consecutiveErrors >= MAX_ERRORS) {
        log?.error?.(`[openclaw-max] Too many consecutive errors, stopping long polling`);
        break;
      }

      // Exponential backoff: 1s, 2s, 4s, 8s, 16s
      const delay = Math.min(1000 * Math.pow(2, consecutiveErrors - 1), 30_000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  log?.info?.(`[openclaw-max] Long polling stopped for account ${account.accountId}`);
}
