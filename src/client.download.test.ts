/**
 * Скачивание входящих вложений по URL и по токену.
 *
 * Эти хелперы (`downloadFileMeta`, `getFileByToken`, `getVideoDownloadUrl`)
 * обслуживают приём file/audio/video из вебхука (PR #10). MAX отдаёт их
 * тремя разными способами — прямой URL, JSON-метаданные по токену, или сами
 * байты — поэтому каждый путь проверяется отдельно.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();

vi.mock("undici", () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
  FormData: globalThis.FormData,
  Agent: class {},
  ProxyAgent: class {},
}));

const { downloadFileMeta, downloadFile, getFileByToken, getVideoDownloadUrl } =
  await import("./client.js");

const TOKEN = "test-token";

/** Ответ MAX API так, как его читает `maxRequest` (через `.text()`). */
function apiResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

/** Ответ-файл так, как его читают `downloadFileMeta` / `getFileByToken`. */
function fileResponse(
  status: number,
  body: Buffer | string,
  headers: Record<string, string> = {},
) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("downloadFileMeta", () => {
  it("возвращает байты, content-type и имя из content-disposition", async () => {
    fetchMock.mockResolvedValueOnce(
      fileResponse(200, "hello", {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": 'attachment; filename="note.txt"',
      }),
    );

    const got = await downloadFileMeta(TOKEN, "https://cdn.example/note.txt");
    expect(got?.buf.toString()).toBe("hello");
    expect(got?.contentType).toBe("text/plain; charset=utf-8");
    expect(got?.filename).toBe("note.txt");
  });

  it("разбирает RFC5987 filename* в content-disposition", async () => {
    fetchMock.mockResolvedValueOnce(
      fileResponse(200, "x", {
        "content-disposition": "attachment; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82.pdf",
      }),
    );

    const got = await downloadFileMeta(TOKEN, "https://cdn.example/f");
    expect(got?.filename).toBe("отчёт.pdf");
  });

  it("на не-2xx ответе возвращает null", async () => {
    fetchMock.mockResolvedValueOnce(fileResponse(404, ""));
    await expect(downloadFileMeta(TOKEN, "https://cdn.example/x")).resolves.toBeNull();
  });

  it("на пустом теле возвращает null", async () => {
    fetchMock.mockResolvedValueOnce(fileResponse(200, Buffer.alloc(0)));
    await expect(downloadFileMeta(TOKEN, "https://cdn.example/x")).resolves.toBeNull();
  });

  it("на сетевой ошибке возвращает null, а не бросает", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(downloadFileMeta(TOKEN, "https://cdn.example/x")).resolves.toBeNull();
  });

  it("downloadFile отдаёт только буфер", async () => {
    fetchMock.mockResolvedValueOnce(fileResponse(200, "bytes", {}));
    const buf = await downloadFile(TOKEN, "https://cdn.example/x");
    expect(buf?.toString()).toBe("bytes");
  });
});

describe("getFileByToken", () => {
  it("JSON-метаданные с url и filename → отдаёт ссылку и имя", async () => {
    fetchMock.mockResolvedValueOnce(
      fileResponse(200, JSON.stringify({ url: "https://cdn.example/real.bin", filename: "real.bin" }), {
        "content-type": "application/json",
      }),
    );

    const got = await getFileByToken(TOKEN, "tok-1");
    expect(got?.url).toBe("https://cdn.example/real.bin");
    expect(got?.filename).toBe("real.bin");
    expect(got?.buf).toBeUndefined();
  });

  it("тело-похожее-на-JSON без известных ключей трактуется как сам файл", async () => {
    // начинается с '{' по content-type octet-stream, но это не метаданные API
    fetchMock.mockResolvedValueOnce(
      fileResponse(200, "{not really json", { "content-type": "application/octet-stream" }),
    );

    const got = await getFileByToken(TOKEN, "tok-2");
    expect(got?.buf?.toString()).toBe("{not really json");
    expect(got?.url).toBeUndefined();
  });

  it("бинарное тело возвращается как байты", async () => {
    fetchMock.mockResolvedValueOnce(
      fileResponse(200, Buffer.from([0x00, 0x01, 0x02]), { "content-type": "application/pdf" }),
    );

    const got = await getFileByToken(TOKEN, "tok-3");
    expect(Array.from(got?.buf ?? [])).toEqual([0x00, 0x01, 0x02]);
    expect(got?.contentType).toBe("application/pdf");
  });

  it("на не-2xx ответе возвращает null", async () => {
    fetchMock.mockResolvedValueOnce(fileResponse(500, "boom"));
    await expect(getFileByToken(TOKEN, "tok-4")).resolves.toBeNull();
  });

  it("на сетевой ошибке возвращает null", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout"));
    await expect(getFileByToken(TOKEN, "tok-5")).resolves.toBeNull();
  });
});

describe("getVideoDownloadUrl", () => {
  it("выбирает максимальное доступное качество из PREFERRED_VIDEO_KEYS", async () => {
    fetchMock.mockResolvedValueOnce(
      apiResponse(200, {
        urls: { mp4_360: "https://v/360.mp4", mp4_720: "https://v/720.mp4" },
      }),
    );

    await expect(getVideoDownloadUrl(TOKEN, "vid-1")).resolves.toBe("https://v/720.mp4");
  });

  it("фолбэк на любой http(s)-url, но не на .m3u8", async () => {
    fetchMock.mockResolvedValueOnce(
      apiResponse(200, {
        urls: { hls: "https://v/stream.m3u8", some_other: "https://v/raw.mp4" },
      }),
    );

    await expect(getVideoDownloadUrl(TOKEN, "vid-2")).resolves.toBe("https://v/raw.mp4");
  });

  it("возвращает null, когда urls отсутствует", async () => {
    fetchMock.mockResolvedValueOnce(apiResponse(200, {}));
    await expect(getVideoDownloadUrl(TOKEN, "vid-3")).resolves.toBeNull();
  });

  it("возвращает null, когда есть только .m3u8", async () => {
    fetchMock.mockResolvedValueOnce(apiResponse(200, { urls: { hls: "https://v/stream.m3u8" } }));
    await expect(getVideoDownloadUrl(TOKEN, "vid-4")).resolves.toBeNull();
  });

  it("на ошибке API возвращает null", async () => {
    fetchMock.mockResolvedValueOnce(apiResponse(500, "boom"));
    await expect(getVideoDownloadUrl(TOKEN, "vid-5")).resolves.toBeNull();
  });
});
