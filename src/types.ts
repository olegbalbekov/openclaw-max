/**
 * TypeScript types for the MAX Bot API.
 * https://dev.max.ru/docs-api
 */

// ─── Inbound delivery ─────────────────────────────────────────────────────────

/** One inbound image, already downloaded and base64-encoded for the agent. */
export interface InboundImage {
  data: string;
  mimeType: string;
}

/**
 * What the webhook/polling handler hands to the channel for one inbound message.
 *
 * `webhook-handler.ts` is a compiled copy carrying `@ts-nocheck`, so the shape is
 * declared here instead: `channel.ts` imported `InboundImage` from that module,
 * which never exported it, and the build reported the error on every run.
 */
export interface InboundDelivery {
  text: string;
  senderId: string;
  senderName: string;
  chatId: string;
  dialogChatId: string;
  chatType: string;
  messageId: string;
  accountId: string;
  images?: InboundImage[];
}

// ─── Config ───────────────────────────────────────────────────────────────────

/** Reference to a secret the host resolves before the plugin reads the config. */
export interface MaxSecretRef {
  source: string;
  provider?: string;
  id?: string;
}

/** Plain token or a SecretRef to it. */
export type MaxTokenInput = string | MaxSecretRef;

export interface MaxAccountConfig {
  enabled?: boolean;
  /** Bot token from MAX Partner Platform, or a SecretRef to it */
  token?: MaxTokenInput;
  /**
   * Public HTTPS URL for webhook delivery (e.g. https://yourdomain.com/max/webhook).
   * If omitted, the plugin falls back to long polling.
   */
  webhookUrl?: string;
  /** Secret sent in X-Max-Bot-Api-Secret header to validate webhook requests */
  webhookSecret?: string;
  /** Gateway-internal HTTP path for the webhook route (default: /max/webhook) */
  webhookPath?: string;
  /** DM policy: who can send messages to the bot */
  dmPolicy?: "open" | "allowlist" | "pairing" | "disabled";
  /** Allowlisted MAX user IDs (numeric) or usernames */
  allowFrom?: string[];
  /**
   * Optional HTTP(S) proxy for all MAX API traffic, e.g. http://user:pass@host:port.
   * Useful when the gateway has no direct route to platform-api2.max.ru.
   */
  httpProxy?: string;
}

export interface MaxConfig extends MaxAccountConfig {
  accounts?: Record<string, MaxAccountConfig>;
}

export interface ResolvedMaxAccount {
  accountId: string;
  /** Empty when the token is missing or its SecretRef was not resolved. */
  token: string;
  /** `source:provider:id` of a SecretRef the host left unresolved. */
  tokenUnresolved?: string;
  enabled: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookPath: string;
  dmPolicy: "open" | "allowlist" | "pairing" | "disabled";
  allowFrom: string[];
  httpProxy?: string;
}

// ─── API objects ──────────────────────────────────────────────────────────────

export interface MaxUser {
  user_id: number;
  name: string;
  username?: string;
  is_bot?: boolean;
  last_activity_time?: number;
}

export interface MaxRecipient {
  chat_id?: number;
  user_id?: number;
  chat_type?: "dialog" | "chat" | "channel";
}

export interface MaxImagePayload {
  token?: string;
  url?: string;
  file_id?: string;
  filename?: string;
  name?: string;
  fileName?: string;
  width?: number;
  height?: number;
}

export interface MaxAttachment {
  type: "image" | "video" | "audio" | "file" | "inline_keyboard" | "sticker" | "location";
  payload: MaxImagePayload;
  filename?: string;
  size?: number;
}

export interface MaxMessageBody {
  mid: string;
  seq: number;
  text?: string;
  attachments?: MaxAttachment[];
}

export interface MaxMessage {
  sender?: MaxUser;
  recipient: MaxRecipient;
  timestamp: number;
  body?: MaxMessageBody;
  url?: string;
}

export interface MaxBotStartedEvent {
  chat_id: number;
  user: MaxUser;
  timestamp: number;
  payload?: string;
}

// ─── Updates ──────────────────────────────────────────────────────────────────

export type MaxUpdateType =
  | "message_created"
  | "message_callback"
  | "bot_started"
  | "bot_removed"
  | "user_added"
  | "user_removed"
  | "chat_title_changed"
  | "message_removed"
  | "message_edited";

export interface MaxUpdate {
  update_type: MaxUpdateType;
  timestamp?: number;
  // message_created / message_edited
  message?: MaxMessage;
  // bot_started / bot_removed / user_added / user_removed
  chat_id?: number;
  user?: MaxUser;
  // message_callback
  callback?: {
    timestamp: number;
    callback_id: string;
    message?: MaxMessage;
    payload?: string;
    user: MaxUser;
  };
}

export interface MaxUpdatesResponse {
  updates: MaxUpdate[];
  marker?: number | null;
}
