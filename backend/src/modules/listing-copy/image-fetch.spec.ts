import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { fetchImage, hostAllowed, ImageFetchError, imageProblem, sniffImage } from "./image-fetch";

/** A minimal PNG of the given size (IHDR is all sniffing reads). */
function png(width: number, height: number): Uint8Array {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return Buffer.concat([b, deflateSync(Buffer.alloc(4))]);
}

/** JPEG markers up to a baseline start of frame. */
function jpeg(width: number, height: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3, ...Array(9).fill(0)];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof, 0xff, 0xd9]);
}

function webpVp8x(width: number, height: number): Uint8Array {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "ascii");
  b.write("WEBPVP8X", 8, "ascii");
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

const cfg = { extraHosts: [], allowHttp: false };

function fakeFetch(routes: Record<string, () => Response>) {
  const seen: string[] = [];
  const fn = (async (input: URL | string) => {
    const url = String(input);
    seen.push(url);
    const route = routes[url];
    return route ? route() : new Response("no", { status: 404 });
  }) as typeof fetch;
  return { fn, seen };
}

describe("image hosts", () => {
  it("takes only https on the marketplaces' image hosts and their subdomains", () => {
    const ok = (u: string) => hostAllowed(new URL(u), cfg);
    expect(ok("https://down-id.img.susercontent.com/file/abc")).toBe(true);
    expect(ok("https://cf.shopee.co.id/file/abc")).toBe(true);
    expect(ok("https://p16-oec-sg.ibyteimg.com/tos/abc~tplv-origin-jpeg.jpeg")).toBe(true);
    expect(ok("http://cf.shopee.co.id/file/abc")).toBe(false);
    expect(ok("https://cf.shopee.co.id:8443/file/abc")).toBe(false);
    expect(ok("https://evilshopee.co.id/file/abc")).toBe(false);
    expect(ok("https://cf.shopee.co.id.evil.com/x")).toBe(false);
    expect(ok("https://user:pw@cf.shopee.co.id/x")).toBe(false);
    expect(ok("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(
      hostAllowed(new URL("http://127.0.0.1:4321/img/a.png"), { extraHosts: ["127.0.0.1"], allowHttp: true }),
    ).toBe(true);
  });
});

describe("sniffing images", () => {
  it("reads type and pixel size of JPEG, PNG, WebP, GIF, and BMP", () => {
    expect(sniffImage(jpeg(800, 600))).toEqual({ kind: "jpeg", width: 800, height: 600 });
    expect(sniffImage(png(1200, 900))).toEqual({ kind: "png", width: 1200, height: 900 });
    expect(sniffImage(webpVp8x(640, 480))).toEqual({ kind: "webp", width: 640, height: 480 });
    expect(sniffImage(new Uint8Array([...Buffer.from("GIF89a"), 0x20, 0x03, 0x58, 0x02]))).toEqual({
      kind: "gif",
      width: 800,
      height: 600,
    });
    expect(sniffImage(new TextEncoder().encode("<html>not an image</html>"))).toBeNull();
  });

  it("explains what each marketplace refuses", () => {
    expect(imageProblem({ kind: "webp", width: 800, height: 800 }, "shopee", "main")).toMatch(/hanya JPG dan PNG/);
    expect(imageProblem({ kind: "webp", width: 800, height: 800 }, "tiktokshop", "main")).toBeNull();
    expect(imageProblem({ kind: "jpeg", width: 250, height: 250 }, "tiktokshop", "main")).toMatch(/300–4000 px/);
    expect(imageProblem({ kind: "jpeg", width: 250, height: 250 }, "tiktokshop", "variant")).toBeNull();
    expect(imageProblem({ kind: "png", width: 800, height: 600 }, "tiktokshop", "size_chart")).toMatch(/1024 px/);
    expect(imageProblem({ kind: "png", width: 80, height: 600 }, "tiktokshop", "variant")).toMatch(/terlalu kecil/);
  });
});

describe("downloading", () => {
  it("returns the bytes with the type read from them, not from the header", async () => {
    const f = fakeFetch({
      "https://cf.shopee.co.id/file/a": () =>
        new Response(png(600, 600), { status: 200, headers: { "content-type": "application/octet-stream" } }),
    });
    const img = await fetchImage("https://cf.shopee.co.id/file/a", { ...cfg, fetch: f.fn });
    expect(img).toMatchObject({ kind: "png", contentType: "image/png", width: 600, height: 600 });
  });

  it("follows redirects only while they stay on marketplace hosts", async () => {
    const f = fakeFetch({
      "https://cf.shopee.co.id/file/a": () =>
        new Response(null, { status: 302, headers: { location: "https://down-id.img.susercontent.com/file/a" } }),
      "https://down-id.img.susercontent.com/file/a": () => new Response(jpeg(500, 500), { status: 200 }),
      "https://cf.shopee.co.id/file/b": () =>
        new Response(null, { status: 302, headers: { location: "http://10.0.0.5/admin" } }),
    });
    expect((await fetchImage("https://cf.shopee.co.id/file/a", { ...cfg, fetch: f.fn })).kind).toBe("jpeg");
    await expect(fetchImage("https://cf.shopee.co.id/file/b", { ...cfg, fetch: f.fn })).rejects.toMatchObject({
      problem: "host",
    });
    expect(f.seen).not.toContain("http://10.0.0.5/admin");
  });

  it("refuses other hosts without fetching, failed answers, files over the limit, and non-images", async () => {
    const f = fakeFetch({
      "https://cf.shopee.co.id/file/gone": () => new Response("x", { status: 404 }),
      "https://cf.shopee.co.id/file/big": () =>
        new Response(new Uint8Array(64), { status: 200, headers: { "content-length": String(20 * 1024 * 1024) } }),
      "https://cf.shopee.co.id/file/stream": () => new Response(new Uint8Array(2048), { status: 200 }),
      "https://cf.shopee.co.id/file/html": () => new Response("<html></html>", { status: 200 }),
    });
    const get = (u: string, max?: number) =>
      fetchImage(u, { ...cfg, fetch: f.fn, ...(max ? { maxBytes: max } : {}) }).catch((e: unknown) => e);
    expect(await get("https://localhost/x")).toMatchObject({ problem: "host" });
    expect(await get("not a url")).toMatchObject({ problem: "url" });
    expect(await get("https://cf.shopee.co.id/file/gone")).toMatchObject({ problem: "http" });
    expect(await get("https://cf.shopee.co.id/file/big")).toMatchObject({ problem: "size" });
    expect(await get("https://cf.shopee.co.id/file/stream", 1024)).toMatchObject({ problem: "size" });
    const html = await get("https://cf.shopee.co.id/file/html");
    expect(html).toBeInstanceOf(ImageFetchError);
    expect(html).toMatchObject({ problem: "format" });
    expect(f.seen).not.toContain("https://localhost/x");
  });
});
