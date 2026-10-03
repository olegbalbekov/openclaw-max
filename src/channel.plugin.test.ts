/**
 * Поверхность плагина: настройки, сопряжение, исходящая отправка и запуск
 * канала (вебхук и длинный опрос).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const client = {
  sendDm: vi.fn(),
  sendToChat: vi.fn(),
  sendDmWithImage: vi.fn(),
  sendToChatWithImage: vi.fn(),
  editMessage: vi.fn(),
  markSeen: vi.fn(),
  sendTypingAction: vi.fn(),
  getUpdates: vi.fn(),
  subscribeWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  getBotInfo: vi.fn(),
  getUploadUrl: vi.fn(),
  uploadFile: vi.fn(),
  configureMaxTransport: vi.fn(),
  createUpload: vi.fn(),
  uploadToUrl: vi.fn(),
  sendWithAttachment: vi.fn(),
};
vi.mock("./client.js", () => client);

const registerPluginHttpRoute = vi.fn((..._args: unknown[]) => vi.fn());
vi.mock("openclaw/plugin-sdk/webhook-ingress", () => ({
  registerPluginHttpRoute: (...args: unknown[]) => registerPluginHttpRoute(...args),
}));

const setAccountEnabledInConfigSection = vi.fn((args: Record<string, unknown>) => ({
  marked: args.accountId,
}));
// Новые подпути SDK, которые тянет channel.ts: без них набор падает в CI, где ядра нет.
vi.mock("openclaw/plugin-sdk/secret-input", async () => {
  const { z } = await import("zod");
  return {
    buildOptionalSecretInputSchema: () =>
      z.union([z.string(), z.object({ source: z.string(), provider: z.string(), id: z.string() })]).optional(),
  };
});
vi.mock("./secret-contract.js", () => ({
  secretTargetRegistryEntries: [],
  collectRuntimeConfigAssignments: () => {},
}));
vi.mock("openclaw/plugin-sdk/core", () => ({
  buildChannelConfigSchema: (shape: unknown) => shape,
  DEFAULT_ACCOUNT_ID: "default",
  setAccountEnabledInConfigSection: (...args: [Record<string, unknown>]) =>
    setAccountEnabledInConfigSection(...args),
}));
vi.mock("openclaw/plugin-sdk/channel-outbound", () => ({
  resolveChannelPreviewStreamMode: () => "progress",
}));
vi.mock("./progress-draft.js", () => ({
  createMaxProgressDraft: () => ({
    compositor: {
      pushNarrationProgress: vi.fn(),
      pushReasoningProgress: vi.fn(),
      pushToolEvent: vi.fn(),
      pushItemEvent: vi.fn(),
      pushApprovalEvent: vi.fn(),
      markFinalReplyStarted: vi.fn(),
      markFinalReplyDelivered: vi.fn(),
    },
    currentMessageId: () => undefined,
    overwrite: vi.fn(),
    showPlaceholder: vi.fn(),
    remove: vi.fn(),
    detach: vi.fn(),
    close: vi.fn(),
  }),
  resolveMaxProgressLabel: () => "⏳ Работаю",
}));
vi.mock("./runtime.js", () => ({ getMaxRuntime: vi.fn() }));

const createWebhookHandler = vi.fn((..._args: unknown[]) => async () => new Response("ok"));
const handleUpdate = vi.fn((..._args: unknown[]) => undefined);
vi.mock("./webhook-handler.js", () => ({
  createWebhookHandler: (...args: unknown[]) => createWebhookHandler(...args),
  handleUpdate: (...args: unknown[]) => handleUpdate(...args),
}));

const { createMaxPlugin } = await import("./channel.js");

const plugin = createMaxPlugin();
const cfg = { channels: { max: { token: "tok", dmPolicy: "allowlist", allowFrom: ["42"] } } };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** Сигнал прерывания, который можно взвести из теста. */
function abortable() {
  const controller = new AbortController();
  return { signal: controller.signal, abort: () => controller.abort() };
}

beforeEach(() => {
  vi.clearAllMocks();
  client.getBotInfo.mockReset();
  client.sendTypingAction.mockResolvedValue(undefined);
  client.markSeen.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("описание канала", () => {
  it("отдаёт ядру контракт секретов: реестр путей и сборщик назначений", () => {
    expect(plugin.secrets).toEqual({
      secretTargetRegistryEntries: expect.any(Array),
      collectRuntimeConfigAssignments: expect.any(Function),
    });
  });

  it("объявляет себя каналом MAX с поддержкой медиа", () => {
    expect(plugin.id).toBe("max");
    expect(plugin.capabilities.media).toBe(true);
    expect(plugin.capabilities.chatTypes).toEqual(["direct", "group"]);
    expect(plugin.reload.configPrefixes).toEqual(["channels.max"]);
  });

  it("подсказки агенту упоминают предел длины сообщения", () => {
    expect(plugin.agentPrompt.messageToolHints().join("\n")).toContain("4000");
  });
});

describe("настройки учёток", () => {
  it("перечисление и разбор идут через общий код", () => {
    expect(plugin.config.listAccountIds(cfg)).toEqual(["default"]);
    expect(plugin.config.resolveAccount(cfg).token).toBe("tok");
    expect(plugin.config.defaultAccountId(cfg)).toBe("default");
  });

  it("включение учётки по умолчанию правит корень настроек канала", () => {
    const next = plugin.config.setAccountEnabled({ cfg, accountId: "default", enabled: false });
    expect(next.channels.max.enabled).toBe(false);
    expect(next.channels.max.token).toBe("tok");
  });

  it("включение именованной учётки отдаётся ядру", () => {
    plugin.config.setAccountEnabled({ cfg, accountId: "work", enabled: true });
    expect(setAccountEnabledInConfigSection).toHaveBeenCalledWith(
      expect.objectContaining({ sectionKey: "channels.max", accountId: "work", enabled: true }),
    );
  });
});

describe("сопряжение и доступ", () => {
  it("идентификатор чистится от префиксов", () => {
    expect(plugin.pairing.normalizeAllowEntry(" max:user:42 ")).toBe("42");
  });

  it("одобрение шлёт личное сообщение", async () => {
    await plugin.pairing.notifyApproval({ cfg, id: "42" });
    expect(client.sendDm).toHaveBeenCalledWith("tok", 42, expect.stringContaining("approved"));
  });

  it("без токена и на нечисловом идентификаторе одобрение молчит", async () => {
    await plugin.pairing.notifyApproval({ cfg: {}, id: "42" });
    await plugin.pairing.notifyApproval({ cfg, id: "не-число" });
    expect(client.sendDm).not.toHaveBeenCalled();
  });

  it("политика личных сообщений берётся из учётки", () => {
    expect(plugin.security.resolveDmPolicy({ cfg })).toMatchObject({
      policy: "allowlist",
      allowFrom: ["42"],
      policyPath: "channels.max.dmPolicy",
    });
  });

  it("справочник собеседников пуст — MAX его не отдаёт", async () => {
    await expect(plugin.directory.self()).resolves.toBeNull();
    await expect(plugin.directory.listPeers()).resolves.toEqual([]);
    await expect(plugin.directory.listGroups()).resolves.toEqual([]);
  });

  it("индикатор набора уходит только при токене и числовом адресате", async () => {
    await plugin.heartbeat.sendTyping({ cfg, to: "max:user:42" });
    expect(client.sendTypingAction).toHaveBeenCalledWith("tok", 42);

    client.sendTypingAction.mockClear();
    await plugin.heartbeat.sendTyping({ cfg: {}, to: "42" });
    await plugin.heartbeat.sendTyping({ cfg, to: "abc" });
    expect(client.sendTypingAction).not.toHaveBeenCalled();
  });
});

describe("исходящая отправка", () => {
  it("текст уходит в личку", async () => {
    client.sendDm.mockResolvedValueOnce("mid-1");
    const res = await plugin.outbound.sendText({ to: "max:user:42", text: "привет", cfg });
    expect(client.sendDm).toHaveBeenCalledWith("tok", 42, "привет");
    expect(res).toMatchObject({ channel: "max", chatId: "max:user:42" });
  });

  it("без токена, с плохим адресом и при отказе API — внятные ошибки", async () => {
    await expect(plugin.outbound.sendText({ to: "42", text: "x", cfg: {} })).rejects.toThrow(
      "token not configured",
    );
    await expect(plugin.outbound.sendText({ to: "max:user:abc", text: "x", cfg })).rejects.toThrow(
      "Invalid MAX user ID",
    );
    client.sendDm.mockResolvedValueOnce(null);
    await expect(plugin.outbound.sendText({ to: "42", text: "x", cfg })).rejects.toThrow(
      "Failed to send",
    );
  });

  it("картинка грузится загрузчиком и уходит вложением", async () => {
    client.getUploadUrl.mockResolvedValueOnce("https://up.test");
    client.uploadFile.mockResolvedValueOnce({ token: "img" });
    client.sendDmWithImage.mockResolvedValueOnce("mid-img");

    const res = await plugin.outbound.sendMedia({
      to: "42",
      buffer: Buffer.from("x"),
      mimeType: "image/png",
      filename: "a.png",
      caption: "подпись",
      cfg,
      chatType: "direct",
    });

    expect(client.sendDmWithImage).toHaveBeenCalledWith("tok", 42, "подпись", "img");
    expect(res.messageId).toBe("mid-img");
  });

  it("распознаёт PNG по байтам, когда outbound bridge не передал MIME", async () => {
    client.getUploadUrl.mockResolvedValueOnce("https://up.test");
    client.uploadFile.mockResolvedValueOnce({ token: "img" });
    client.sendDmWithImage.mockResolvedValueOnce("mid-png");

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    await plugin.outbound.sendMedia({
      to: "42",
      buffer: png,
      caption: "без MIME",
      cfg,
      chatType: "direct",
    });

    expect(client.getUploadUrl).toHaveBeenCalledWith("tok", "image");
    expect(client.createUpload).not.toHaveBeenCalled();
    expect(client.sendDmWithImage).toHaveBeenCalledWith("tok", 42, "без MIME", "img");
  });

  it.each([
    ["локальный путь", "/tmp/openclaw/test-no-mime.png"],
    ["HTTPS URL", "https://media.test/signed/test-no-mime.png?token=secret"],
  ])("читает mediaUrl (%s) только через контракт OpenClaw", async (_label, mediaUrl) => {
    client.getUploadUrl.mockResolvedValueOnce("https://up.test");
    client.uploadFile.mockResolvedValueOnce({ token: "img" });
    client.sendDmWithImage.mockResolvedValueOnce("mid-url-png");

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const mediaReadFile = vi.fn().mockResolvedValue(png);
    const res = await plugin.outbound.sendMedia({
      to: "42",
      mediaUrl,
      mediaReadFile,
      text: "актуальный контракт",
      cfg,
      chatType: "direct",
    });

    expect(mediaReadFile).toHaveBeenCalledWith(mediaUrl);
    expect(client.createUpload).not.toHaveBeenCalled();
    expect(client.uploadFile).toHaveBeenCalledWith(
      "https://up.test",
      png,
      "application/octet-stream",
      "test-no-mime.png",
    );
    expect(client.sendDmWithImage).toHaveBeenCalledWith("tok", 42, "актуальный контракт", "img");
    expect(res.messageId).toBe("mid-url-png");
  });

  it.each([
    "https://127.0.0.1/admin?token=must-not-leak",
    "/etc/passwd",
    "file:///etc/shadow",
  ])("не делает прямой HTTP/fs fallback без mediaReadFile: %s", async (mediaUrl) => {
    await expect(plugin.outbound.sendMedia({
      to: "42",
      mediaUrl,
      cfg,
      chatType: "direct",
    })).rejects.toThrow("MAX outbound media requires OpenClaw mediaReadFile");

    expect(client.getUploadUrl).not.toHaveBeenCalled();
    expect(client.createUpload).not.toHaveBeenCalled();
  });

  it("скрывает URL, токен и ошибку mediaReadFile при отказе загрузчика", async () => {
    const mediaReadFile = vi.fn().mockRejectedValue(
      new Error("GET https://media.test/file?token=super-secret body=password"),
    );

    let error: unknown;
    try {
      await plugin.outbound.sendMedia({
        to: "42",
        mediaUrl: "https://media.test/file?token=super-secret",
        mediaReadFile,
        cfg,
        chatType: "direct",
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toEqual(new Error("OpenClaw could not read outbound media for MAX"));
    expect(String(error)).not.toContain("super-secret");
    expect(String(error)).not.toContain("password");
    expect(client.getUploadUrl).not.toHaveBeenCalled();
  });

  it("не превращает декодированные разделители URL в путь имени файла", async () => {
    client.createUpload.mockResolvedValueOnce({ url: "https://up.test", token: "file-token" });
    client.uploadToUrl.mockResolvedValueOnce({ token: null });
    client.sendWithAttachment.mockResolvedValueOnce("mid-file");
    const mediaReadFile = vi.fn().mockResolvedValue(Buffer.from("payload"));

    await plugin.outbound.sendMedia({
      to: "42",
      mediaUrl: "https://media.test/files/nested%2Fsecret%5Cname.bin?token=hidden",
      mediaReadFile,
      cfg,
      chatType: "direct",
    });

    expect(client.uploadToUrl).toHaveBeenCalledWith(
      "https://up.test",
      expect.any(Buffer),
      "application/octet-stream",
      "nested_secret_name.bin",
    );
  });

  it("в группу картинка уходит своим вызовом", async () => {
    client.getUploadUrl.mockResolvedValueOnce("https://up.test");
    client.uploadFile.mockResolvedValueOnce({ token: "img" });
    client.sendToChatWithImage.mockResolvedValueOnce("mid-img");

    await plugin.outbound.sendMedia({
      to: "42",
      buffer: Buffer.from("x"),
      mimeType: "image/png",
      cfg,
      chatType: "group",
    });

    expect(client.sendToChatWithImage).toHaveBeenCalled();
  });

  it("звук уходит вложением, а не текстом с подписью", async () => {
    // Раньше здесь был откат в текст: голос до собеседника не доходил вовсе.
    client.createUpload.mockResolvedValueOnce({ url: "https://up.test", token: "attach" });
    client.uploadToUrl.mockResolvedValueOnce({ token: null });
    client.sendWithAttachment.mockResolvedValueOnce("mid-audio");

    const res = await plugin.outbound.sendMedia({
      to: "42",
      buffer: Buffer.from("x"),
      mimeType: "audio/ogg",
      filename: "voice.ogg",
      cfg,
    });

    expect(client.sendWithAttachment).toHaveBeenCalledWith(
      "tok",
      { kind: "direct", id: 42 },
      "",
      { type: "audio", payload: { token: "attach" } },
    );
    expect(res.messageId).toBe("mid-audio");
  });

  it("документ уходит вложением типа file", async () => {
    client.createUpload.mockResolvedValueOnce({ url: "https://up.test", token: "attach" });
    client.uploadToUrl.mockResolvedValueOnce({ token: "from-uploader" });
    client.sendWithAttachment.mockResolvedValueOnce("mid-file");

    await plugin.outbound.sendMedia({
      to: "42",
      buffer: Buffer.from("x"),
      mimeType: "application/pdf",
      filename: "report.pdf",
      caption: "отчёт",
      cfg,
      chatType: "group",
    });

    expect(client.sendWithAttachment).toHaveBeenCalledWith(
      "tok",
      { kind: "chat", id: 42 },
      "отчёт",
      { type: "file", payload: { token: "from-uploader" } },
    );
  });

  it("видео определяется по типу содержимого", async () => {
    client.createUpload.mockResolvedValueOnce({ url: "https://up.test", token: "attach" });
    client.uploadToUrl.mockResolvedValueOnce({ token: null });
    client.sendWithAttachment.mockResolvedValueOnce("mid-video");

    await plugin.outbound.sendMedia({
      to: "42",
      buffer: Buffer.from("x"),
      mimeType: "video/mp4",
      cfg,
    });

    expect(client.createUpload).toHaveBeenCalledWith("tok", "video");
  });

  it("без типа содержимого вложение считается файлом", async () => {
    client.createUpload.mockResolvedValueOnce({ url: "https://up.test", token: "attach" });
    client.uploadToUrl.mockResolvedValueOnce({ token: null });
    client.sendWithAttachment.mockResolvedValueOnce("mid-file");

    await plugin.outbound.sendMedia({ to: "42", buffer: Buffer.from("x"), cfg });

    expect(client.createUpload).toHaveBeenCalledWith("tok", "file");
  });

  it("сбои загрузки превращаются в ошибки, а не в молчание", async () => {
    client.getUploadUrl.mockResolvedValueOnce(null);
    await expect(
      plugin.outbound.sendMedia({ to: "42", buffer: Buffer.from("x"), mimeType: "image/png", cfg }),
    ).rejects.toThrow("upload URL");

    client.getUploadUrl.mockResolvedValueOnce("https://up.test");
    client.uploadFile.mockResolvedValueOnce(null);
    await expect(
      plugin.outbound.sendMedia({ to: "42", buffer: Buffer.from("x"), mimeType: "image/png", cfg }),
    ).rejects.toThrow("upload file");

    client.createUpload.mockResolvedValueOnce(null);
    await expect(
      plugin.outbound.sendMedia({ to: "42", buffer: Buffer.from("x"), mimeType: "audio/ogg", cfg }),
    ).rejects.toThrow("create MAX upload");
  });
});

describe("запуск канала", () => {
  it("выключенная учётка и учётка без токена только ждут остановки", async () => {
    const off = abortable();
    const disabled = plugin.gateway.startAccount({
      cfg: { channels: { max: { token: "t", enabled: false } } },
      accountId: "default",
      log,
      abortSignal: off.signal,
    });
    off.abort();
    await disabled;
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("disabled"));

    const noToken = abortable();
    const missing = plugin.gateway.startAccount({
      cfg: { channels: { max: {} } },
      accountId: "default",
      log,
      abortSignal: noToken.signal,
    });
    noToken.abort();
    await missing;
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("missing token"));
    expect(client.getBotInfo).not.toHaveBeenCalled();
  });

  it("неразрешённая ссылка на токен: внятная ошибка, в API не ходим", async () => {
    const ref = { source: "exec", provider: "vault", id: "max/bot-token" };
    const ctl = abortable();
    const started = plugin.gateway.startAccount({
      cfg: { channels: { max: { token: ref } } },
      accountId: "default",
      log,
      abortSignal: ctl.signal,
    });
    ctl.abort();
    await started;

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("SecretRef exec:vault:max/bot-token is not resolved"));
    expect(client.getBotInfo).not.toHaveBeenCalled();
    expect(client.configureMaxTransport).not.toHaveBeenCalled();

    const refCfg = { channels: { max: { token: ref } } };
    await expect(plugin.outbound.sendText({ to: "42", text: "x", cfg: refCfg })).rejects.toThrow("is not resolved");
    await expect(
      plugin.outbound.sendMedia({ to: "42", buffer: Buffer.from("x"), mimeType: "image/png", cfg: refCfg }),
    ).rejects.toThrow("is not resolved");
    expect(client.sendDm).not.toHaveBeenCalled();
  });

  it("неверный токен останавливает запуск после проверки", async () => {
    client.getBotInfo.mockRejectedValue(Object.assign(new Error("401 unauthorized"), { status: 401 }));
    const ctl = abortable();

    const started = plugin.gateway.startAccount({
      cfg,
      accountId: "default",
      log,
      abortSignal: ctl.signal,
    });
    await vi.waitFor(() => expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Token verification failed")));
    ctl.abort();
    await started;

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Token verification failed"));
    expect(client.getUpdates).not.toHaveBeenCalled();
  });

  it("передаёт lifecycle signal в активную проверку токена и быстро останавливается", async () => {
    const ctl = abortable();
    client.getBotInfo.mockImplementationOnce(async (_token: string, signal: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    const started = plugin.gateway.startAccount({ cfg, accountId: "default", log, abortSignal: ctl.signal });
    await vi.waitFor(() => expect(client.getBotInfo).toHaveBeenCalledWith("tok", ctl.signal));
    ctl.abort();
    await started;

    expect(client.getBotInfo).toHaveBeenCalledTimes(1);
    expect(client.getUpdates).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining("Connection lost during token verification"));
  });

  it("временный сбой проверки токена повторяется и затем подключается", async () => {
    vi.useFakeTimers();
    client.getBotInfo
      .mockRejectedValueOnce(Object.assign(new Error("temporary"), { status: 503 }))
      .mockResolvedValueOnce({ name: "бот", username: "bot" });
    const ctl = abortable();
    client.getUpdates.mockImplementation(async () => {
      ctl.abort();
      return { updates: [], marker: null };
    });

    const started = plugin.gateway.startAccount({ cfg, accountId: "default", log, abortSignal: ctl.signal });
    await vi.advanceTimersByTimeAsync(2_000);
    await started;

    expect(client.getBotInfo).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Connection lost during token verification"));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Connected as bot"));
  });

  it("с прокси транспорт настраивается до первого вызова", async () => {
    client.getBotInfo.mockResolvedValueOnce({ name: "бот", username: "bot" });
    client.getUpdates.mockResolvedValue({ updates: [], marker: null });
    const ctl = abortable();

    const started = plugin.gateway.startAccount({
      cfg: { channels: { max: { token: "tok", httpProxy: "http://proxy.test" } } },
      accountId: "default",
      log,
      abortSignal: ctl.signal,
    });
    ctl.abort();
    await started;

    expect(client.configureMaxTransport).toHaveBeenCalledWith({ httpProxy: "http://proxy.test" });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("proxy"));
  });

  it("при webhookUrl регистрируется маршрут, а не опрос", async () => {
    client.getBotInfo.mockResolvedValueOnce({ name: "бот", username: "bot" });
    client.subscribeWebhook.mockResolvedValueOnce(undefined);
    const ctl = abortable();

    const started = plugin.gateway.startAccount({
      cfg: { channels: { max: { token: "tok", webhookUrl: "https://h.test/hook" } } },
      accountId: "default",
      log,
      abortSignal: ctl.signal,
    });
    ctl.abort();
    await started;

    expect(client.subscribeWebhook).toHaveBeenCalled();
    expect(registerPluginHttpRoute).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/max/webhook", pluginId: "max" }),
    );
    expect(client.getUpdates).not.toHaveBeenCalled();
  });

  it("сбой подписки на вебхук не роняет запуск", async () => {
    client.getBotInfo.mockResolvedValueOnce({ name: "бот", username: "bot" });
    client.subscribeWebhook.mockRejectedValueOnce(new Error("403"));
    const ctl = abortable();

    const started = plugin.gateway.startAccount({
      cfg: { channels: { max: { token: "tok", webhookUrl: "https://h.test/hook" } } },
      accountId: "default",
      log,
      abortSignal: ctl.signal,
    });
    ctl.abort();
    await started;

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Failed to register webhook"));
    expect(registerPluginHttpRoute).not.toHaveBeenCalled();
  });

  it("без webhookUrl идёт длинный опрос и обновления уходят обработчику", async () => {
    client.getBotInfo.mockResolvedValueOnce({ name: "бот", username: "bot" });
    const ctl = abortable();
    client.getUpdates
      .mockResolvedValueOnce({ updates: [{ update_type: "message_created" }], marker: 11 })
      .mockImplementationOnce(async () => {
        if (!ctl.signal.aborted) {
          await new Promise<void>((resolve) => ctl.signal.addEventListener("abort", () => resolve(), { once: true }));
        }
        return { updates: [], marker: 11 };
      });

    const started = plugin.gateway.startAccount({ cfg, accountId: "default", log, abortSignal: ctl.signal });
    await vi.waitFor(() => expect(handleUpdate).toHaveBeenCalledOnce());
    ctl.abort();
    await started;

    expect(client.getUpdates).toHaveBeenCalled();
    expect(handleUpdate).toHaveBeenCalledWith(
      { update_type: "message_created" },
      expect.objectContaining({ token: "tok" }),
      expect.any(Function),
      log,
    );
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Received 1 update"));
  });

  it("остановка учётки пишется в лог", async () => {
    await plugin.gateway.stopAccount({ accountId: "default", log });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("stopped"));
  });
});
