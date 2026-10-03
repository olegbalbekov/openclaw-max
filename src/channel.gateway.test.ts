/**
 * Внутренности запуска канала: длинный опрос с ошибками и откатом, вебхук с
 * обработчиком и снятием устаревшего маршрута, разбор сетевых вложений.
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

const unregisterRoute = vi.fn();
const registerPluginHttpRoute = vi.fn((..._args: unknown[]) => unregisterRoute);
vi.mock("openclaw/plugin-sdk/webhook-ingress", () => ({
  registerPluginHttpRoute: (...args: unknown[]) => registerPluginHttpRoute(...args),
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
  setAccountEnabledInConfigSection: vi.fn(),
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

const loadWebMedia = vi.fn();
const dispatch = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("./runtime.js", () => ({
  getMaxRuntime: () => ({
    media: { loadWebMedia: (...args: unknown[]) => loadWebMedia(...args) },
    channel: {
      routing: { resolveAgentRoute: () => ({ sessionKey: "agent:main:max:direct:42" }) },
      reply: {
        finalizeInboundContext: (ctx: unknown) => ctx,
        dispatchReplyWithBufferedBlockDispatcher: (...a: unknown[]) => dispatch(...a),
      },
    },
  }),
}));

const webhookHandlerParams: Array<Record<string, unknown>> = [];
const createWebhookHandler = vi.fn((params: Record<string, unknown>) => {
  webhookHandlerParams.push(params);
  return async () => new Response("ok");
});
const handleUpdate = vi.fn((..._args: unknown[]) => Promise.resolve());
vi.mock("./webhook-handler.js", () => ({
  createWebhookHandler: (...args: [Record<string, unknown>]) => createWebhookHandler(...args),
  handleUpdate: (...args: unknown[]) => handleUpdate(...args),
}));

const { createMaxPlugin, collectOutboundMedia, createStreamingDeliver } = await import(
  "./channel.js"
);

const plugin = createMaxPlugin();
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const inbound = {
  text: "привет",
  senderId: "42",
  senderName: "IZ",
  chatId: "42",
  dialogChatId: "42",
  chatType: "direct",
  messageId: "mid-in",
  accountId: "default",
};

beforeEach(() => {
  vi.clearAllMocks();
  webhookHandlerParams.length = 0;
  client.sendTypingAction.mockResolvedValue(undefined);
  client.markSeen.mockResolvedValue(undefined);
  client.getBotInfo.mockResolvedValue({ name: "бот", username: "bot" });
  loadWebMedia.mockResolvedValue({ buffer: Buffer.from("media") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("вебхук", () => {
  const cfg = { channels: { max: { token: "tok", webhookUrl: "https://h.test/hook" } } };

  it("обработчик вебхука прогоняет сообщение через ход", async () => {
    const ctl = new AbortController();
    const started = plugin.gateway.startAccount({
      cfg,
      accountId: "default",
      log,
      abortSignal: ctl.signal,
    });
    ctl.abort();
    await started;

    const deliver = webhookHandlerParams[0]?.deliver as (msg: unknown) => Promise<unknown>;
    await expect(deliver(inbound)).resolves.toBeNull();
    expect(dispatch).toHaveBeenCalled();
  });

  it.each([
    {
      label: "картинку",
      mediaUrl: "https://media.test/agent-reply.png",
      setup: () => {
        client.getUploadUrl.mockResolvedValue("https://upload.test/image");
        client.uploadFile.mockResolvedValue({ token: "image-token" });
        client.sendDmWithImage.mockResolvedValue("mid-image");
      },
      assertSent: () => {
        expect(client.uploadFile).toHaveBeenCalledWith(
          "https://upload.test/image",
          Buffer.from("media"),
          "image/png",
          "agent-reply.png",
        );
        expect(client.sendDmWithImage).toHaveBeenCalledWith("tok", 42, "", "image-token");
      },
    },
    {
      label: "голосовой ответ",
      mediaUrl: "https://media.test/agent-reply.ogg",
      setup: () => {
        client.createUpload.mockResolvedValue({
          url: "https://upload.test/audio",
          token: "audio-token",
        });
        client.uploadToUrl.mockResolvedValue({ token: "audio-token" });
        client.sendWithAttachment.mockResolvedValue("mid-audio");
      },
      assertSent: () => {
        expect(client.uploadToUrl).toHaveBeenCalledWith(
          "https://upload.test/audio",
          Buffer.from("media"),
          "audio/ogg",
          "agent-reply.ogg",
        );
        expect(client.sendWithAttachment).toHaveBeenCalledWith(
          "tok",
          { kind: "direct", id: 42 },
          "",
          { type: "audio", payload: { token: "audio-token" } },
        );
      },
    },
  ])(
    "ответ агента читает и отправляет $label через runtime OpenClaw",
    async ({ mediaUrl, setup, assertSent }) => {
      setup();
      dispatch.mockImplementationOnce(async (params: any) => {
        await params.dispatcherOptions.deliver({ text: "", mediaUrl }, { kind: "final" });
      });

      const ctl = new AbortController();
      const started = plugin.gateway.startAccount({
        cfg,
        accountId: "default",
        log,
        abortSignal: ctl.signal,
      });
      ctl.abort();
      await started;

      const deliver = webhookHandlerParams[0]?.deliver as (msg: unknown) => Promise<unknown>;
      await expect(deliver(inbound)).resolves.toBeNull();

      expect(loadWebMedia).toHaveBeenCalledWith(mediaUrl, { localRoots: "any" });
      assertSent();
    },
  );

  it("повторный запуск снимает устаревший маршрут", async () => {
    // Второй запуск ДО остановки первого: именно так выглядит перезагрузка
    // настроек, и без снятия старого маршрута их осталось бы два.
    const first = new AbortController();
    const firstStarted = plugin.gateway.startAccount({
      cfg,
      accountId: "default",
      log,
      abortSignal: first.signal,
    });
    await vi.waitFor(() => expect(registerPluginHttpRoute).toHaveBeenCalledTimes(1));

    const second = new AbortController();
    const secondStarted = plugin.gateway.startAccount({
      cfg,
      accountId: "default",
      log,
      abortSignal: second.signal,
    });
    await vi.waitFor(() => expect(registerPluginHttpRoute).toHaveBeenCalledTimes(2));

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Deregistering stale"));
    expect(unregisterRoute).toHaveBeenCalled();

    first.abort();
    second.abort();
    await Promise.all([firstStarted, secondStarted]);
  });

  it("при остановке снимается подписка, а её сбой не мешает", async () => {
    // Снятие подписки — уборка по мере возможности: если MAX недоступен,
    // останов канала всё равно должен завершиться.
    client.deleteWebhook.mockRejectedValueOnce(new Error("max unreachable"));
    const ctl = new AbortController();

    const started = plugin.gateway.startAccount({
      cfg,
      accountId: "default",
      log,
      abortSignal: ctl.signal,
    });
    ctl.abort();

    await expect(started).resolves.toBeUndefined();
    expect(client.deleteWebhook).toHaveBeenCalledWith("tok");
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Stopping webhook mode"));
  });
});

describe("отметка о прочтении", () => {
  it("ставится один раз в начале хода", async () => {
    createStreamingDeliver(
      { accountId: "default", token: "tok", enabled: true } as never,
      "42",
      "392679003",
      "direct",
      {} as never,
      "progress" as never,
      "seed",
      log,
    );

    expect(client.markSeen).toHaveBeenCalledTimes(1);
    expect(client.markSeen).toHaveBeenCalledWith("tok", 392679003);
  });

  it("на нечисловом чате не шлётся", () => {
    createStreamingDeliver(
      { accountId: "default", token: "tok", enabled: true } as never,
      "42",
      "нечисло",
      "direct",
      {} as never,
      "progress" as never,
      "seed",
      log,
    );

    expect(client.markSeen).not.toHaveBeenCalled();
  });
});

describe("индикатор набора", () => {
  it("обновляется, пока идёт ход", async () => {
    // MAX гасит индикатор через несколько секунд, поэтому его шлют заново по
    // таймеру; без этого «печатает…» пропадает на длинном ходе.
    vi.useFakeTimers();
    const deliverer = createStreamingDeliver(
      { accountId: "default", token: "tok", enabled: true } as never,
      "42",
      "42",
      "direct",
      {} as never,
      "progress" as never,
      "seed",
      log,
    );

    expect(client.sendTypingAction).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9000);
    expect(client.sendTypingAction.mock.calls.length).toBeGreaterThan(1);

    await deliverer.finish();
    const afterFinish = client.sendTypingAction.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9000);
    // После завершения хода индикатор больше не шлётся.
    expect(client.sendTypingAction).toHaveBeenCalledTimes(afterFinish);
  });
});

describe("длинный опрос", () => {
  const cfg = { channels: { max: { token: "tok" } } };

  it("обновление уходит обработчику, и тот прогоняет ход", async () => {
    const ctl = new AbortController();
    client.getUpdates
      .mockResolvedValueOnce({ updates: [{ update_type: "message_created" }], marker: 3 })
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => ctl.signal.addEventListener("abort", () => resolve(), { once: true }));
        return { updates: [], marker: 3 };
      });

    const started = plugin.gateway.startAccount({ cfg, accountId: "default", log, abortSignal: ctl.signal });
    await vi.waitFor(() => expect(handleUpdate).toHaveBeenCalledOnce());

    const deliver = handleUpdate.mock.calls[0]?.[2] as (msg: unknown) => Promise<unknown>;
    await expect(deliver(inbound)).resolves.toBeNull();
    expect(dispatch).toHaveBeenCalled();
    ctl.abort();
    await started;
  });

  it("повторяет сбойный update до успеха, сохраняет порядок и только потом двигает marker", async () => {
    vi.useFakeTimers();
    const ctl = new AbortController();
    const first = { update_type: "message_created", message: { body: { mid: "first" } } };
    const second = { update_type: "message_created", message: { body: { mid: "second" } } };
    client.getUpdates
      .mockResolvedValueOnce({ updates: [first, second], marker: 4 })
      .mockImplementationOnce(async (_token: string, marker: number | null | undefined) => {
        expect(marker).toBe(4);
        ctl.abort();
        return { updates: [], marker: 4 };
      });
    handleUpdate
      .mockRejectedValueOnce(new TypeError("transient handler bug"))
      .mockResolvedValue(undefined);

    const started = plugin.gateway.startAccount({ cfg, accountId: "default", log, abortSignal: ctl.signal });
    await vi.advanceTimersByTimeAsync(2_000);
    await started;

    expect(handleUpdate.mock.calls.map((call) => call[0])).toEqual([first, first, second]);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("MAX update processing failed; retry 1/2"));
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining("MAX connection lost"));
  });

  it("не двигает marker и не обгоняет update после исчерпания попыток", async () => {
    vi.useFakeTimers();
    const ctl = new AbortController();
    const first = { update_type: "message_created", message: { body: { mid: "first" } } };
    const second = { update_type: "message_created", message: { body: { mid: "second" } } };
    client.getUpdates.mockResolvedValueOnce({ updates: [first, second], marker: 7 });
    handleUpdate.mockRejectedValue(new TypeError("persistent handler bug"));

    const started = plugin.gateway.startAccount({ cfg, accountId: "default", log, abortSignal: ctl.signal });
    const rejected = expect(started).rejects.toThrow("persistent handler bug");
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;

    expect(handleUpdate).toHaveBeenCalledTimes(3);
    expect(handleUpdate.mock.calls.every((call) => call[0] === first)).toBe(true);
    expect(client.getUpdates).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("marker not advanced"));
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining("MAX connection lost"));
  });

  it("abort останавливает retry update без marker advance", async () => {
    vi.useFakeTimers();
    const ctl = new AbortController();
    const update = { update_type: "message_created", message: { body: { mid: "abort" } } };
    client.getUpdates.mockResolvedValueOnce({ updates: [update], marker: 9 });
    handleUpdate.mockRejectedValue(new TypeError("handler bug"));

    const started = plugin.gateway.startAccount({ cfg, accountId: "default", log, abortSignal: ctl.signal });
    await vi.waitFor(() => expect(handleUpdate).toHaveBeenCalledOnce());
    ctl.abort();
    await vi.runAllTimersAsync();
    await started;

    expect(handleUpdate).toHaveBeenCalledTimes(1);
    expect(client.getUpdates).toHaveBeenCalledTimes(1);
    expect(log.error).not.toHaveBeenCalledWith(expect.stringContaining("marker not advanced"));
  });

  it("ошибка опроса считается и ход повторяется после паузы", async () => {
    vi.useFakeTimers();
    const ctl = new AbortController();
    let calls = 0;
    client.getUpdates.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError("network down");
      ctl.abort();
      return { updates: [], marker: null };
    });

    const started = plugin.gateway.startAccount({
      cfg,
      accountId: "default",
      log,
      abortSignal: ctl.signal,
    });
    await vi.advanceTimersByTimeAsync(5000);
    await started;

    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("MAX connection lost"));
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("после череды ошибок опрос продолжает попытки и восстанавливается", async () => {
    vi.useFakeTimers();
    const ctl = new AbortController();
    let calls = 0;
    client.getUpdates.mockImplementation(async () => {
      calls += 1;
      if (calls <= 6) throw new TypeError("network down");
      ctl.abort();
      return { updates: [], marker: null };
    });

    const started = plugin.gateway.startAccount({ cfg, accountId: "default", log, abortSignal: ctl.signal });
    await vi.runAllTimersAsync();

    await expect(started).resolves.toBeUndefined();
    expect(client.getUpdates).toHaveBeenCalledTimes(7);
  });
  it("прерывание во время ошибки не считается сбоем", async () => {
    const ctl = new AbortController();
    client.getUpdates.mockImplementation(async () => {
      ctl.abort();
      throw new Error("aborted mid-flight");
    });

    await plugin.gateway.startAccount({ cfg, accountId: "default", log, abortSignal: ctl.signal });

    expect(log.error).not.toHaveBeenCalledWith(expect.stringContaining("Too many consecutive"));
  });
});

describe("вложение по ссылке", () => {
  const mediaReadFile = vi.fn();
  const draftlessDeliverer = (loader: ((ref: string) => Promise<Buffer>) | null = mediaReadFile) =>
    createStreamingDeliver(
      { accountId: "default", token: "tok", enabled: true } as never,
      "42",
      "нечисло",
      "direct",
      {} as never,
      "progress" as never,
      "seed",
      log,
      loader ?? undefined,
    );

  it("картинка по http читается platform loader перед загрузкой", async () => {
    mediaReadFile.mockResolvedValueOnce(Buffer.from("img"));
    client.getUploadUrl.mockResolvedValue("https://up.test");
    client.uploadFile.mockResolvedValue({ token: "img" });
    client.sendDmWithImage.mockResolvedValue("mid-img");
    const { deliver, finish } = draftlessDeliverer();

    await deliver({ text: "", mediaUrl: "https://cdn.test/a.png" }, { kind: "final" });
    await finish();

    expect(mediaReadFile).toHaveBeenCalledWith("https://cdn.test/a.png");
    expect(client.sendDmWithImage).toHaveBeenCalled();
  });

  it("ошибка platform loader гасится, редактируется и попадает в лог", async () => {
    mediaReadFile.mockRejectedValueOnce(new Error("token=secret request-body=password"));
    const { deliver, finish } = draftlessDeliverer();

    await deliver({ text: "Готово", mediaUrl: "https://cdn.test/a.png" }, { kind: "final" });
    await finish();

    expect(log.error).toHaveBeenCalledWith(
      "[openclaw-max] вложение отправить не удалось: OpenClaw could not read outbound media for MAX",
    );
    expect(String(log.error.mock.calls)).not.toContain("secret");
    expect(String(log.error.mock.calls)).not.toContain("password");
  });

  it("без platform loader URL не вызывает fetch и закрывается отказом", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { deliver, finish } = draftlessDeliverer(null);

    await deliver({ text: "Готово", mediaUrl: "https://127.0.0.1/a.png" }, { kind: "final" });
    await finish();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(
      "[openclaw-max] вложение отправить не удалось: MAX outbound media requires OpenClaw mediaReadFile",
    );
    fetchSpy.mockRestore();
  });

  it("ссылка с процентом в имени не мешает разбору", () => {
    expect(collectOutboundMedia({ mediaUrl: "https://cdn.test/100%.png" })[0]).toMatchObject({
      name: "100%.png",
      mimeType: "image/png",
    });
  });
});
