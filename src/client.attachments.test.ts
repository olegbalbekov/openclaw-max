/**
 * Вложения общего вида: загрузка и отправка.
 *
 * Эти три помощника появились потому, что звук в MAX устроен не так, как
 * картинка, и каждая проверка здесь соответствует конкретной находке живой
 * отправки 22.09.2026 — см. комментарий в `client.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("undici", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
  FormData: globalThis.FormData,
  Agent: class {},
  ProxyAgent: class {},
}));

const { createUpload, uploadToUrl, sendWithAttachment } = await import("./client.js");

const TOKEN = "test-token";

/** Ответ MAX API в том виде, в каком его читает `maxRequest`. */
function apiResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("createUpload", () => {
  it("отдаёт и адрес загрузчика, и токен вложения", async () => {
    fetchMock.mockResolvedValueOnce(
      apiResponse(200, { url: "https://upload.example/put", token: "attach-1" }),
    );

    await expect(createUpload(TOKEN, "audio")).resolves.toEqual({
      url: "https://upload.example/put",
      token: "attach-1",
    });
  });

  it("без токена сохраняет URL: актуальный загрузчик отдаёт token после multipart", async () => {
    fetchMock.mockResolvedValueOnce(apiResponse(200, { url: "https://upload.example/put" }));

    await expect(createUpload(TOKEN, "image")).resolves.toEqual({
      url: "https://upload.example/put",
      token: "",
    });
  });

  it("на ошибке API возвращает null, а не бросает", async () => {
    fetchMock.mockResolvedValueOnce(apiResponse(500, "boom"));

    await expect(createUpload(TOKEN, "audio")).resolves.toBeNull();
  });
});

describe("uploadToUrl", () => {
  it("берёт токен из ответа загрузчика, когда тот его даёт", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ token: "from-uploader" }),
    });

    await expect(
      uploadToUrl("https://upload.example/put", Buffer.from("x"), "image/png", "a.png"),
    ).resolves.toEqual({ token: "from-uploader" });
  });

  it("ответ не в JSON — это успех без токена, а не провал", async () => {
    // Загрузчик аудио отвечает `<retval>1</retval>`. Родной `uploadFile`
    // считает это провалом, и звук «не отправлялся», хотя файл уже загружен.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => "<retval>1</retval>",
    });

    await expect(
      uploadToUrl("https://upload.example/put", Buffer.from("x"), "audio/ogg", "a.ogg"),
    ).resolves.toEqual({ token: null });
  });

  it("отказ загрузчика — null", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 413, text: async () => "too big" });

    await expect(
      uploadToUrl("https://upload.example/put", Buffer.from("x"), "audio/ogg", "a.ogg"),
    ).resolves.toBeNull();
  });

  it("сетевой сбой — null, наружу не бросает", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    await expect(
      uploadToUrl("https://upload.example/put", Buffer.from("x"), "audio/ogg", "a.ogg"),
    ).resolves.toBeNull();
  });
});

describe("sendWithAttachment", () => {
  const attachment = { type: "audio", payload: { token: "attach-1" } };

  it("отправляет в личку по user_id и возвращает mid", async () => {
    fetchMock.mockResolvedValueOnce(apiResponse(200, { message: { body: { mid: "mid-1" } } }));

    await expect(
      sendWithAttachment(TOKEN, { kind: "direct", id: 42 }, "подпись", attachment),
    ).resolves.toBe("mid-1");

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("user_id=42");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      attachments: [attachment],
      text: "подпись",
    });
  });

  it("в чат уходит по chat_id, пустая подпись не попадает в тело", async () => {
    fetchMock.mockResolvedValueOnce(apiResponse(200, { message: { body: { mid: "mid-2" } } }));

    await sendWithAttachment(TOKEN, { kind: "chat", id: 7 }, "", attachment);

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("chat_id=7");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      attachments: [attachment],
    });
  });

  it("пережидает attachment.not.ready и отправляет со второй попытки", async () => {
    // Ровно то, что видно живьём: файл загружен, но ещё обрабатывается.
    fetchMock
      .mockResolvedValueOnce(apiResponse(400, { code: "attachment.not.ready" }))
      .mockResolvedValueOnce(apiResponse(200, { message: { body: { mid: "mid-3" } } }));

    await expect(
      sendWithAttachment(TOKEN, { kind: "direct", id: 42 }, "", attachment, [0, 1]),
    ).resolves.toBe("mid-3");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("любую другую ошибку бросает сразу, не перебирая попытки", async () => {
    fetchMock.mockResolvedValueOnce(apiResponse(403, { code: "access.denied" }));

    await expect(
      sendWithAttachment(TOKEN, { kind: "direct", id: 42 }, "", attachment, [0, 1, 2]),
    ).rejects.toThrow("access.denied");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("если готовности так и не дождались — бросает последнюю ошибку", async () => {
    fetchMock.mockResolvedValue(apiResponse(400, { code: "attachment.not.ready" }));

    await expect(
      sendWithAttachment(TOKEN, { kind: "direct", id: 42 }, "", attachment, [0, 1]),
    ).rejects.toThrow("attachment.not.ready");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
