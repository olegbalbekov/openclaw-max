/**
 * Доставка ответа: рассказ по ходу работы, сам ответ, голос и картинки.
 *
 * Каждая проверка здесь отвечает конкретному дефекту, найденному на живом
 * канале 22.09.2026:
 *  - медиа терялось молча (ни отправки, ни ошибки в логе);
 *  - рассказ «сейчас посмотрю» приходил ПОСЛЕ ответа и затирал его;
 *  - голосовой довесок переписывал текст ответа.
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

const mediaReadFile = vi.fn();

const draft = {
  compositor: {
    pushNarrationProgress: vi.fn(),
    pushReasoningProgress: vi.fn(),
    pushToolEvent: vi.fn(),
    pushItemEvent: vi.fn(),
    pushApprovalEvent: vi.fn(),
    markFinalReplyStarted: vi.fn(),
    markFinalReplyDelivered: vi.fn(),
  },
  currentMessageId: vi.fn(),
  overwrite: vi.fn(),
  showPlaceholder: vi.fn(),
  remove: vi.fn(),
  detach: vi.fn(),
  close: vi.fn(),
};

vi.mock("./progress-draft.js", () => ({
  createMaxProgressDraft: () => draft,
  resolveMaxProgressLabel: () => "⏳ Работаю",
}));

vi.mock("openclaw/plugin-sdk/channel-outbound", () => ({
  resolveChannelPreviewStreamMode: () => "progress",
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
vi.mock("openclaw/plugin-sdk/webhook-ingress", () => ({ registerPluginHttpRoute: vi.fn() }));
vi.mock("./runtime.js", () => ({ getMaxRuntime: vi.fn() }));
vi.mock("./webhook-handler.js", () => ({ createWebhookHandler: vi.fn(), handleUpdate: vi.fn() }));

const { createStreamingDeliver, collectOutboundMedia } = await import("./channel.js");

const account = { accountId: "default", token: "tok", enabled: true } as never;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** Созданные в тесте доставщики — их надо закрывать, иначе течёт таймер набора. */
const made: Array<{ finish: () => Promise<void> }> = [];

function makeDeliverer(chatType = "direct") {
  const deliverer = createStreamingDeliver(
    account,
    "42",
    "42",
    chatType,
    {} as never,
    "progress" as never,
    "seed",
    log,
    mediaReadFile,
  );
  made.push(deliverer);
  return deliverer;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Плагин зовёт индикатор набора и вешает `.catch` — пустышка должна быть обещанием.
  client.sendTypingAction.mockResolvedValue(undefined);
  client.markSeen.mockResolvedValue(undefined);
  draft.currentMessageId.mockReturnValue(undefined);
  draft.overwrite.mockResolvedValue(true);
  client.editMessage.mockResolvedValue(true);
  client.sendDm.mockResolvedValue("mid-answer");
  mediaReadFile.mockResolvedValue(Buffer.from("bytes"));
});

afterEach(async () => {
  // `finish` гасит индикатор набора: без него интервал живёт до конца прогона.
  for (const deliverer of made.splice(0)) await deliverer.finish();
});

describe("collectOutboundMedia", () => {
  it("тип берётся из attachments, иначе по расширению; дубли снимаются", () => {
    const items = collectOutboundMedia({
      mediaUrl: "/tmp/a.png",
      mediaUrls: ["/tmp/a.png", "/tmp/voice.ogg", "https://e.test/pic.JPG?sig=1#x", "/tmp/odd"],
      attachments: [{ mediaUrl: "/tmp/odd", mimeType: "image/webp" }],
    });

    expect(items).toEqual([
      { ref: "/tmp/a.png", mimeType: "image/png", name: "a.png" },
      { ref: "/tmp/voice.ogg", mimeType: "audio/ogg", name: "voice.ogg" },
      { ref: "https://e.test/pic.JPG?sig=1#x", mimeType: "image/jpeg", name: "pic.JPG" },
      { ref: "/tmp/odd", mimeType: "image/webp", name: "odd" },
    ]);
  });

  it("без медиа отдаёт пустой список", () => {
    expect(collectOutboundMedia({ text: "привет" })).toEqual([]);
  });
});

describe("deliver: рассказ по ходу работы", () => {
  it("kind=block уходит в черновик, а не в ответ", async () => {
    const { deliver } = makeDeliverer();

    await deliver({ text: "Посмотрю, есть ли датчик" }, { kind: "block" });

    expect(draft.compositor.pushNarrationProgress).toHaveBeenCalledWith("Посмотрю, есть ли датчик");
    expect(client.editMessage).not.toHaveBeenCalled();
    expect(client.sendDm).not.toHaveBeenCalled();
  });

  it("пустой промежуточный кусок не трогает черновик", async () => {
    const { deliver } = makeDeliverer();

    await deliver({ text: "   " }, { kind: "block" });

    expect(draft.compositor.pushNarrationProgress).not.toHaveBeenCalled();
  });

  it("рассказ, пришедший ПОСЛЕ ответа, ответ не затирает", async () => {
    // Ровно порядок из лога 13:18: final на 687 символов, следом block на 171.
    const { deliver } = makeDeliverer();
    draft.currentMessageId.mockReturnValue("mid-draft");

    await deliver({ text: "Датчик работает" }, { kind: "final" });
    client.editMessage.mockClear();
    await deliver({ text: "Посмотрю, есть ли датчик" }, { kind: "block" });

    expect(client.editMessage).not.toHaveBeenCalled();
  });
});

describe("deliver: ответ", () => {
  it("финал переписывает черновик на месте, без метки и шагов", async () => {
    const { deliver } = makeDeliverer();
    draft.currentMessageId.mockReturnValue("mid-draft");

    await deliver({ text: "Датчик работает" }, { kind: "final" });

    expect(draft.compositor.markFinalReplyStarted).toHaveBeenCalled();
    expect(client.editMessage).toHaveBeenCalledWith("tok", "mid-draft", "Датчик работает");
    // Именно detach, а не close: сообщение стало ответом, удалять его нельзя.
    expect(draft.detach).toHaveBeenCalled();
    expect(draft.remove).not.toHaveBeenCalled();
    expect(client.sendDm).not.toHaveBeenCalled();
  });

  it("без черновика ответ уходит новым сообщением", async () => {
    const { deliver } = makeDeliverer();

    await deliver({ text: "Датчик работает" }, { kind: "final" });

    expect(client.sendDm).toHaveBeenCalledWith("tok", 42, "Датчик работает");
  });

  it("если правка черновика не прошла, ответ всё равно доходит", async () => {
    const { deliver } = makeDeliverer();
    draft.currentMessageId.mockReturnValue("mid-draft");
    client.editMessage.mockResolvedValueOnce(false);

    await deliver({ text: "Датчик работает" }, { kind: "final" });

    expect(draft.remove).toHaveBeenCalled();
    expect(client.sendDm).toHaveBeenCalledWith("tok", 42, "Датчик работает");
  });

  it("отсутствие kind считается финалом — совместимость со старым ядром", async () => {
    const { deliver } = makeDeliverer();

    await deliver({ text: "Ответ" });

    expect(client.sendDm).toHaveBeenCalledWith("tok", 42, "Ответ");
  });

  it("пустой финал отдаёт накопленный рассказ, а не молчит", async () => {
    const { deliver } = makeDeliverer();

    await deliver({ text: "Первый кусок" }, { kind: "block" });
    await deliver({ text: "" }, { kind: "final" });

    expect(client.sendDm).toHaveBeenCalledWith("tok", 42, "Первый кусок");
  });

  it("совсем пустой ход убирает черновик", async () => {
    const { deliver } = makeDeliverer();
    draft.currentMessageId.mockReturnValue("mid-draft");

    await deliver({ text: "NO_REPLY" }, { kind: "final" });

    expect(draft.remove).toHaveBeenCalled();
    expect(client.sendDm).not.toHaveBeenCalled();
  });
});

describe("deliver: голосовой довесок", () => {
  it("когда ответ ещё не показан, довесок отдаёт и текст", async () => {
    // В MAX куски `block` только копятся в черновике и наружу не уходят,
    // поэтому «текст уже показан» со стороны ядра здесь не значит ничего:
    // без этой ветки собеседник получил бы голос и ни строчки текста.
    const { deliver } = makeDeliverer();
    client.createUpload.mockResolvedValue({ url: "https://up.test", token: "attach" });
    client.uploadToUrl.mockResolvedValue({ token: null });
    client.sendWithAttachment.mockResolvedValue("mid-voice");

    await deliver({ text: "Первый кусок" }, { kind: "block" });
    await deliver(
      {
        text: "",
        mediaUrl: "/tmp/voice.ogg",
        ttsSupplement: { spokenText: "Первый кусок", visibleTextAlreadyDelivered: true },
      },
      { kind: "final" },
    );

    expect(client.sendDm).toHaveBeenCalledWith("tok", 42, "Первый кусок");
    expect(client.sendWithAttachment).toHaveBeenCalled();
  });

  it("после показанного ответа несёт только звук", async () => {
    // В ВК пропуск этой проверки 08.09.2026 удалил сообщение с ответом.
    const { deliver } = makeDeliverer();
    draft.currentMessageId.mockReturnValue("mid-draft");
    client.createUpload.mockResolvedValue({ url: "https://up.test", token: "attach" });
    client.uploadToUrl.mockResolvedValue({ token: null });
    client.sendWithAttachment.mockResolvedValue("mid-voice");

    await deliver({ text: "Датчик работает" }, { kind: "final" });
    client.editMessage.mockClear();
    await deliver(
      {
        text: "Датчик работает",
        mediaUrl: "/tmp/voice.ogg",
        ttsSupplement: { spokenText: "Датчик работает", visibleTextAlreadyDelivered: true },
      },
      { kind: "final" },
    );

    expect(client.editMessage).not.toHaveBeenCalled();
    expect(client.sendWithAttachment).toHaveBeenCalled();
  });
});

describe("deliver: вложения", () => {
  it("картинка грузится и уходит вложением", async () => {
    const { deliver } = makeDeliverer();
    client.getUploadUrl.mockResolvedValue("https://up.test/img");
    client.uploadFile.mockResolvedValue({ token: "img-token" });
    client.sendDmWithImage.mockResolvedValue("mid-img");

    await deliver({ text: "Вот фото", mediaUrl: "/tmp/a.png" }, { kind: "final" });

    expect(client.sendDm).toHaveBeenCalledWith("tok", 42, "Вот фото");
    expect(client.sendDmWithImage).toHaveBeenCalledWith("tok", 42, "", "img-token");
  });

  it("в групповом чате картинка уходит через sendToChatWithImage", async () => {
    const { deliver } = makeDeliverer("group");
    client.sendToChat.mockResolvedValue("mid-answer");
    client.getUploadUrl.mockResolvedValue("https://up.test/img");
    client.uploadFile.mockResolvedValue({ token: "img-token" });
    client.sendToChatWithImage.mockResolvedValue("mid-img");

    await deliver({ text: "Вот фото", mediaUrl: "/tmp/a.png" }, { kind: "final" });

    expect(client.sendToChatWithImage).toHaveBeenCalledWith("tok", 42, "", "img-token");
  });

  it("звук грузится своим путём: токен от createUpload", async () => {
    const { deliver } = makeDeliverer();
    client.createUpload.mockResolvedValue({ url: "https://up.test/audio", token: "attach-token" });
    client.uploadToUrl.mockResolvedValue({ token: null });
    client.sendWithAttachment.mockResolvedValue("mid-voice");

    await deliver({ text: "Слушай", mediaUrl: "/tmp/voice.ogg" }, { kind: "final" });

    expect(client.sendWithAttachment).toHaveBeenCalledWith(
      "tok",
      { kind: "direct", id: 42 },
      "",
      { type: "audio", payload: { token: "attach-token" } },
    );
  });

  it("тип, который MAX вложением не примет, попадает в лог, а не пропадает молча", async () => {
    const { deliver } = makeDeliverer();

    await deliver({ text: "Документ", mediaUrl: "/tmp/report.pdf" }, { kind: "final" });

    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("вложение пропущено"));
  });

  it("сбой отправки вложения не роняет ход: текст уходит, в логе ошибка", async () => {
    const { deliver } = makeDeliverer();
    client.getUploadUrl.mockResolvedValue(null);

    await expect(
      deliver({ text: "Вот фото", mediaUrl: "/tmp/a.png" }, { kind: "final" }),
    ).resolves.toBeUndefined();

    expect(client.sendDm).toHaveBeenCalledWith("tok", 42, "Вот фото");
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("вложение отправить не удалось"));
  });

  it("вложение промежуточного куска уходит сразу отдельным сообщением", async () => {
    const { deliver } = makeDeliverer();
    client.getUploadUrl.mockResolvedValue("https://up.test/img");
    client.uploadFile.mockResolvedValue({ token: "img-token" });
    client.sendDmWithImage.mockResolvedValue("mid-img");

    await deliver({ text: "смотри", mediaUrl: "/tmp/a.png" }, { kind: "block" });

    expect(client.sendDmWithImage).toHaveBeenCalled();
    expect(draft.compositor.pushNarrationProgress).toHaveBeenCalledWith("смотри");
  });
});

describe("след в логе", () => {
  it("видно, куда ушёл ответ: в черновик или новым сообщением", async () => {
    // Без этих строк разбор хода приходится начинать с установки датчиков —
    // ровно так и вышло 22.09, когда искали пропажу статуса.
    const { deliver } = makeDeliverer();
    draft.currentMessageId.mockReturnValue("mid-draft");
    await deliver({ text: "Ответ" }, { kind: "final" });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("answer in draft mid=mid-draft"));

    log.info.mockClear();
    draft.currentMessageId.mockReturnValue(undefined);
    const second = makeDeliverer();
    await second.deliver({ text: "Ответ" }, { kind: "final" });
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("answer sent mid=mid-answer"));
  });
});

describe("находки ревью 22.09.2026", () => {
  it("второй финал не удаляет уже отправленный ответ", async () => {
    // Ядро может прислать несколько финалов; черновик к этому моменту уже стал
    // ответом, и `remove()` стёр бы его. В ВК на этом 08.09 исчез текст.
    const { deliver } = makeDeliverer();
    draft.currentMessageId.mockReturnValue("mid-draft");

    await deliver({ text: "Ответ" }, { kind: "final" });
    expect(draft.detach).toHaveBeenCalled();

    draft.remove.mockClear();
    await deliver({ text: "" }, { kind: "final" });

    expect(draft.remove).toHaveBeenCalledTimes(1);
    // Удалять нечего: черновик отвязан, и настоящее сообщение не тронуто.
    expect(draft.detach).toHaveBeenCalled();
  });

  it("долговечный результат инструмента доставляется, а не прячется в черновик", async () => {
    // Спрятать в черновик запрос подтверждения — значит отчитаться ядру о
    // доставке и не показать вопрос собеседнику.
    const { deliver } = makeDeliverer();

    await deliver({ text: "Разрешить запуск?" }, { kind: "tool" });

    expect(client.sendDm).toHaveBeenCalledWith("tok", 42, "Разрешить запуск?");
    expect(draft.compositor.pushNarrationProgress).not.toHaveBeenCalled();
  });

  it("неизвестный вид куска тоже доставляется, а не теряется", async () => {
    const { deliver } = makeDeliverer();

    await deliver({ text: "что-то новое" }, { kind: "какой-то-новый-вид" });

    expect(client.sendDm).toHaveBeenCalledWith("tok", 42, "что-то новое");
  });

  it("провал отправки картинки виден в логе, а не выдаётся за успех", async () => {
    // `sendDmWithImage` глотает ошибку API и отдаёт null.
    const { deliver } = makeDeliverer();
    client.getUploadUrl.mockResolvedValue("https://up.test");
    client.uploadFile.mockResolvedValue({ token: "img" });
    client.sendDmWithImage.mockResolvedValue(null);

    await deliver({ text: "Вот фото", mediaUrl: "/tmp/a.png" }, { kind: "final" });

    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("вложение отправить не удалось"));
    expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining("image sent"));
  });

  it("имя файла с одиночным процентом не роняет весь ответ", async () => {
    // `decodeURIComponent("100%")` бросает URIError, и это происходило в самом
    // начале доставки — вне защиты вокруг медиа.
    const { deliver } = makeDeliverer();
    client.getUploadUrl.mockResolvedValue("https://up.test");
    client.uploadFile.mockResolvedValue({ token: "img" });
    client.sendDmWithImage.mockResolvedValue("mid-img");

    await deliver({ text: "Готово", mediaUrl: "/tmp/скидка 100%.png" }, { kind: "final" });

    expect(client.sendDm).toHaveBeenCalledWith("tok", 42, "Готово");
    expect(client.uploadFile).toHaveBeenCalledWith(
      "https://up.test",
      expect.anything(),
      "image/png",
      "скидка 100%.png",
    );
  });

  it("повторные тики начала работы не перерисовывают черновик", async () => {
    // Ядро зовёт `onWorkStart` каждые несколько секунд, пока держит индикатор
    // набора: каждый тик затирал список шагов одной меткой.
    const d = makeDeliverer();

    await d.onWorkStart();
    await d.onWorkStart();
    await d.onWorkStart();

    expect(draft.showPlaceholder).toHaveBeenCalledTimes(1);
  });
});

describe("шаги хода и завершение", () => {
  it("события работы уходят в компоновщик", async () => {
    const d = makeDeliverer();

    await d.onWorkStart();
    await d.onThinking();
    await d.onToolStart({ name: "Bash", args: { cmd: "ls" } });
    await d.onItemEvent({ title: "шаг" });
    await d.onApprovalEvent({ phase: "requested", title: "подтверди" });

    expect(draft.showPlaceholder).toHaveBeenCalledTimes(1);
    expect(draft.compositor.pushReasoningProgress).toHaveBeenCalled();
    expect(draft.compositor.pushToolEvent).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Bash" }),
    );
    expect(draft.compositor.pushItemEvent).toHaveBeenCalled();
    expect(draft.compositor.pushApprovalEvent).toHaveBeenCalled();
  });

  it("инструмент без имени в черновик не пишется", async () => {
    const d = makeDeliverer();

    await d.onToolStart({ name: "  " });

    expect(draft.compositor.pushToolEvent).not.toHaveBeenCalled();
  });

  it("подтверждение в любой фазе, кроме запроса, пропускается", async () => {
    const d = makeDeliverer();

    await d.onApprovalEvent({ phase: "resolved", title: "поздно" });

    expect(draft.compositor.pushApprovalEvent).not.toHaveBeenCalled();
  });

  it("живой поток правит черновик, когда режим partial", async () => {
    const d = makeDeliverer();

    await d.onPartialToken("часть ответа");

    expect(draft.overwrite).toHaveBeenCalledWith("часть ответа …");
  });

  it("finish без ответа убирает черновик", async () => {
    const d = makeDeliverer();

    await d.finish();

    expect(draft.compositor.markFinalReplyDelivered).toHaveBeenCalled();
    expect(draft.remove).toHaveBeenCalled();
  });

  it("finish после ответа черновик не трогает", async () => {
    const d = makeDeliverer();
    await d.deliver({ text: "Ответ" }, { kind: "final" });

    await d.finish();

    expect(draft.remove).not.toHaveBeenCalled();
  });
});
