/**
 * Входящие вложения: file/audio/video сохраняются на диск, картинки остаются картинками.
 * Webhook и long polling оба вызывают `handleUpdate`, поэтому правила одни.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const downloadFile = vi.hoisted(() => vi.fn());
const downloadFileMeta = vi.hoisted(() => vi.fn());
const getFileByToken = vi.hoisted(() => vi.fn());
const getVideoDownloadUrl = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  downloadFile,
  downloadFileMeta,
  getFileByToken,
  getVideoDownloadUrl,
}));

const { handleUpdate } = await import("./webhook-handler.js");

const BOT_TOKEN = "bot-token-secret";
const PROXY_URL = "http://user:password@proxy.example:8080";

const account = {
  token: BOT_TOKEN,
  accountId: "default",
  dmPolicy: "open" as const,
  allowFrom: [] as string[],
};

let home: string;
let previousHome: string | undefined;

function pngBytes(): Buffer {
  const buf = Buffer.alloc(40, 0);
  buf[0] = 0x89;
  buf[1] = 0x50;
  buf[2] = 0x4e;
  buf[3] = 0x47;
  return buf;
}

function message(body: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    update_type: "message_created",
    message: {
      sender: { user_id: 7, name: "Ada" },
      recipient: { chat_id: 9, chat_type: "dialog" },
      timestamp: 1,
      body: { mid: "mid-1", text: "", ...body },
      ...extra,
    },
  };
}

async function deliverUpdate(update: unknown) {
  const delivered: string[] = [];
  const warnings: string[] = [];
  await handleUpdate(update, account, async (msg) => {
    delivered.push(msg.text);
    return null;
  }, {
    info: () => {},
    warn: (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(" "));
    },
    error: () => {},
  });
  return { text: delivered.join("\n"), warnings };
}

beforeEach(() => {
  downloadFile.mockReset();
  downloadFileMeta.mockReset();
  getFileByToken.mockReset();
  getVideoDownloadUrl.mockReset();
  previousHome = process.env.HOME;
  home = mkdtempSync(path.join(tmpdir(), "max-inbound-"));
  process.env.HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("handleUpdate inbound attachments", () => {
  it("saves a non-image file and appends its absolute path", async () => {
    downloadFileMeta.mockResolvedValue({
      buf: Buffer.from("pdf-bytes"),
      contentType: "application/pdf",
      filename: "notes.pdf",
    });

    const { text } = await deliverUpdate(message({
      attachments: [{
        type: "file",
        payload: { url: "https://files.example/notes.pdf", filename: "notes.pdf" },
      }],
    }));

    const saved = text.match(/\[file: (.+)\]/)?.[1];
    expect(saved).toBeTruthy();
    expect(existsSync(saved!)).toBe(true);
    expect(text).not.toContain("[image:");
  });

  it("keeps an image-extension file on the image path", async () => {
    downloadFile.mockResolvedValue(pngBytes());

    const { text } = await deliverUpdate(message({
      attachments: [{
        type: "file",
        payload: { url: "https://img.example/shot.png", filename: "shot.png" },
      }],
    }));

    expect(text).toMatch(/\[image: .+\]/);
    expect(text).not.toContain("[file:");
    expect(downloadFileMeta).not.toHaveBeenCalled();
  });

  it("still delivers the message when the download fails, without logging secrets", async () => {
    downloadFileMeta.mockResolvedValue(null);

    const { text, warnings } = await deliverUpdate(message({
      text: "hello",
      attachments: [{
        type: "file",
        payload: { url: "https://files.example/missing.pdf", filename: "missing.pdf" },
      }],
    }));

    expect(text).toContain("hello");
    expect(text).toContain("[file: не удалось скачать]");
    const logged = warnings.join("\n");
    expect(logged).toContain("files.example");
    expect(logged).not.toContain(BOT_TOKEN);
    expect(logged).not.toContain(PROXY_URL);
  });

  it("downloads a token-only file and a forwarded file", async () => {
    getFileByToken.mockResolvedValue({ buf: Buffer.from("from-token"), filename: "a.bin" });
    downloadFileMeta.mockResolvedValue({
      buf: Buffer.from("forwarded"),
      contentType: "application/pdf",
      filename: "fwd.pdf",
    });

    const tokenOnly = await deliverUpdate(message({
      attachments: [{ type: "file", payload: { token: "file-tok" } }],
    }));
    expect(tokenOnly.text).toMatch(/\[file: .+\]/);
    expect(getFileByToken).toHaveBeenCalledWith(BOT_TOKEN, "file-tok");

    const forwarded = await deliverUpdate(message({}, {
      link: {
        type: "forward",
        sender: { name: "Bob" },
        message: {
          body: {
            text: "see this",
            attachments: [{
              type: "file",
              payload: { url: "https://files.example/fwd.pdf", filename: "fwd.pdf" },
            }],
          },
        },
      },
    }));
    expect(forwarded.text).toContain("Переслано от Bob");
    expect(forwarded.text).toContain("see this");
    expect(forwarded.text).toMatch(/\[file: .+\]/);
  });
});
