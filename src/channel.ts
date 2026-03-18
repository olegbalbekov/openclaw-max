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
  emptyPluginConfigSchema,
  DEFAULT_ACCOUNT_ID,
  setAccountEnabledInConfigSection,
  registerPluginHttpRoute,
} from "openclaw/plugin-sdk/synology-chat";
import { listAccountIds, resolveAccount } from "./accounts.js";
import { sendDm, sendToChat, editMessage, getUpdates, subscribeWebhook, deleteWebhook, getBotInfo } from "./client.js";
import { getMaxRuntime } from "./runtime.js";
import { createWebhookHandler, handleUpdate } from "./webhook-handler.js";
import type { ResolvedMaxAccount } from "./types.js";

const CHANNEL_ID = "max";
const MaxConfigSchema = emptyPluginConfigSchema();

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
 * Create a streaming deliverer that:
 * 1. Sends first chunk as a new message with ▌ cursor
 * 2. Edits that message as more chunks arrive (throttled to avoid rate limits)
 * 3. finalize() does a final edit removing the cursor
 */
function createStreamingDeliver(
  account: ResolvedMaxAccount,
  chatId: string,
  chatType: string,
  log?: any,
): { deliver: (payload: { text?: string; body?: string }) => Promise<void>; finalize: () => Promise<void> } {
  let messageId: string | null = null;
  let accumulated = "";
  let lastEditAt = 0;
  let pendingEdit: ReturnType<typeof setTimeout> | null = null;

  async function doEdit(text: string) {
    if (!messageId) return;
    await editMessage(account.token, messageId, text);
    lastEditAt = Date.now();
  }

  async function deliver(payload: { text?: string; body?: string }) {
    const chunk = payload?.text ?? payload?.body ?? "";
    if (!chunk) return;

    if (!messageId) {
      // First chunk: send new message with cursor
      accumulated = chunk;
      messageId = await sendReply(account, chatId, chatType, accumulated + " ▌");
      lastEditAt = Date.now();
      log?.info?.(`[openclaw-max] Streaming started, mid=${messageId}`);
      return;
    }

    // Subsequent chunks: accumulate + throttled edit
    accumulated += chunk;
    const elapsed = Date.now() - lastEditAt;

    if (pendingEdit) clearTimeout(pendingEdit);

    if (elapsed >= STREAM_EDIT_INTERVAL_MS) {
      await doEdit(accumulated + " ▌");
    } else {
      pendingEdit = setTimeout(() => {
        doEdit(accumulated + " ▌").catch(() => {});
      }, STREAM_EDIT_INTERVAL_MS - elapsed) as unknown as ReturnType<typeof setTimeout>;
    }
  }

  async function finalize() {
    // Cancel any pending throttled edit
    if (pendingEdit) { clearTimeout(pendingEdit); pendingEdit = null; }
    // Final edit without cursor
    if (messageId && accumulated) {
      await doEdit(accumulated);
    }
  }

  return { deliver, finalize };
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
    chatType,
    messageId,
    accountId,
  }: {
    text: string;
    senderId: string;
    senderName: string;
    chatId: string;
    chatType: string;
    messageId: string;
    accountId: string;
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

  const { deliver: streamDeliver, finalize } = createStreamingDeliver(account, chatId, chatType, log);

  await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: msgCtx,
    cfg,
    dispatcherOptions: {
      deliver: streamDeliver,
      onReplyStart: () => {
        log?.info?.(`[openclaw-max] Agent reply started for ${senderName}`);
      },
    },
  });

  // Remove ▌ cursor from last message
  await finalize();
}

export function createMaxPlugin() {
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
      media: false,
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

      sendMedia: async () => {
        throw new Error("Media attachments are not yet supported in the MAX channel plugin.");
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

async function startWebhookMode(ctx: any, account: ResolvedMaxAccount, cfg: unknown, log: any) {
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

async function startLongPollingMode(ctx: any, account: ResolvedMaxAccount, cfg: unknown, log: any) {
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
