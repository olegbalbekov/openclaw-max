/**
 * Inbound webhook handler for MAX Bot API events.
 * MAX sends JSON POST requests to the registered webhook URL.
 *
 * Security: validate X-Max-Bot-Api-Secret header when configured.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { MaxUpdate, MaxMessage, ResolvedMaxAccount } from "./types.js";
import { downloadFile } from "./client.js";

const MAX_BODY_BYTES = 1_048_576; // 1 MB

function respondJson(res: ServerResponse, code: number, body: Record<string, unknown>) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function respondOk(res: ServerResponse) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        resolve(null);
        return;
      }
      data += chunk.toString("utf8");
    });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(null));
  });
}

function validateSecret(req: IncomingMessage, secret?: string): boolean {
  if (!secret) return true; // no validation if secret not configured
  const header = req.headers["x-max-bot-api-secret"];
  return header === secret;
}

export interface InboundImage {
  data: string; // base64
  mimeType: string;
}

/** Detect image MIME type from magic bytes */
function detectMimeType(buf: Buffer): string {
  // PNG: 89 50 4E 47
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return "image/png";
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "image/jpeg";
  // WebP: RIFF....WEBP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  // GIF: GIF8
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return "image/gif";
  // fallback
  return "image/jpeg";
}

export interface WebhookDeliverMsg {
  text: string;
  senderId: string;
  senderName: string;
  chatId: string;
  /** The actual MAX dialog/chat ID — used for typing indicator */
  dialogChatId: string;
  chatType: "direct" | "chat" | "channel";
  messageId: string;
  accountId: string;
  images?: InboundImage[];
}

export interface WebhookHandlerDeps {
  account: ResolvedMaxAccount;
  deliver: (msg: WebhookDeliverMsg) => Promise<string | null>;
  log?: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

function extractMessage(update: MaxUpdate): MaxMessage | null {
  if (update.update_type === "message_created") {
    return update.message ?? null;
  }
  return null;
}

function resolveChatType(msg: MaxMessage): "direct" | "chat" | "channel" {
  const t = msg.recipient?.chat_type;
  if (t === "dialog") return "direct";
  if (t === "channel") return "channel";
  return "chat";
}

export function createWebhookHandler(deps: WebhookHandlerDeps) {
  const { account, deliver, log } = deps;

  return async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      respondJson(res, 405, { error: "Method not allowed" });
      return;
    }

    // Validate secret
    if (!validateSecret(req, account.webhookSecret)) {
      log?.warn("[openclaw-max] Webhook secret mismatch — rejecting request");
      respondJson(res, 401, { error: "Invalid secret" });
      return;
    }

    const body = await readBody(req);
    if (body === null) {
      respondJson(res, 400, { error: "Invalid body" });
      return;
    }

    let update: MaxUpdate;
    try {
      update = JSON.parse(body) as MaxUpdate;
    } catch {
      respondJson(res, 400, { error: "Invalid JSON" });
      return;
    }

    // ACK immediately — MAX requires HTTP 200 within 30 seconds
    respondOk(res);

    await handleUpdate(update, account, deliver, log);
  };
}

export async function handleUpdate(
  update: MaxUpdate,
  account: ResolvedMaxAccount,
  deliver: WebhookHandlerDeps["deliver"],
  log?: WebhookHandlerDeps["log"],
) {
  const msg = extractMessage(update);
  if (!msg) return; // ignore non-message events for now

  const text = msg.body?.text?.trim() ?? "";
  const imageAttachments = (msg.body?.attachments ?? []).filter(a => a.type === "image");
  if (!text && imageAttachments.length === 0) return;

  const sender = msg.sender;
  if (!sender) return;

  // Skip messages from bots
  if (sender.is_bot) return;

  const chatType = resolveChatType(msg);
  const dialogChatId = String(msg.recipient?.chat_id ?? sender.user_id);
  const chatId =
    chatType === "direct"
      ? String(sender.user_id)
      : dialogChatId;

  const senderId = String(sender.user_id);
  const senderName = sender.name || sender.username || senderId;
  const messageId = msg.body?.mid ?? `max-${msg.timestamp}`;

  // DM policy check
  if (chatType === "direct") {
    const allowed = checkDmPolicy(senderId, account);
    if (!allowed) {
      log?.warn(`[openclaw-max] DM from ${senderName} (${senderId}) rejected by policy`);
      return;
    }
  }

  log?.info(`[openclaw-max] Message from ${senderName} (${senderId}): ${text.slice(0, 80)}`);



  // Download image attachments
  const images: InboundImage[] = [];
  for (const att of imageAttachments) {
    const url = att.payload?.url;
    if (!url) continue;
    const buf = await downloadFile(account.token, url);
    if (!buf) continue;
    const mimeType = detectMimeType(buf);
    images.push({ data: buf.toString("base64"), mimeType });
  }

  try {
    await deliver({
      text,
      senderId,
      senderName,
      chatId,
      dialogChatId,
      chatType,
      messageId,
      accountId: account.accountId,
      images: images.length > 0 ? images : undefined,
    });
  } catch (err) {
    log?.error(
      `[openclaw-max] Deliver error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function checkDmPolicy(userId: string, account: ResolvedMaxAccount): boolean {
  const policy = account.dmPolicy;
  if (policy === "disabled") return false;
  if (policy === "open") return true;
  if (policy === "allowlist" || policy === "pairing") {
    return account.allowFrom.includes(userId) || account.allowFrom.includes(`max:${userId}`);
  }
  return false;
}
