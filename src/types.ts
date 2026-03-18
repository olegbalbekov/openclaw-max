/**
 * TypeScript types for the MAX Bot API.
 * https://dev.max.ru/docs-api
 */

// ─── Config ───────────────────────────────────────────────────────────────────

export interface MaxAccountConfig {
  enabled?: boolean;
  /** Bot token from MAX Partner Platform */
  token?: string;
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
}

export interface MaxConfig extends MaxAccountConfig {
  accounts?: Record<string, MaxAccountConfig>;
}

export interface ResolvedMaxAccount {
  accountId: string;
  token: string;
  enabled: boolean;
  webhookUrl?: string;
  webhookSecret?: string;
  webhookPath: string;
  dmPolicy: "open" | "allowlist" | "pairing" | "disabled";
  allowFrom: string[];
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

export interface MaxMessageBody {
  mid: string;
  seq: number;
  text?: string;
  attachments?: unknown[];
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
