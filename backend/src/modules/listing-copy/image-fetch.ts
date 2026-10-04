/**
 * Downloads a source product's images to upload them to the target marketplace (FR-PRD-13): both
 * marketplaces only take images uploaded to them (Shopee media space, TikTok Shop Upload Product Image).
 *
 * The URLs come from marketplace answers, so the worker only fetches from the marketplaces' image hosts
 * (no request to internal addresses can be smuggled in a product), over https, following at most three
 * redirects that stay on those hosts, up to 10 MB (both marketplaces' upload limit). The file type and
 * pixel size are read from the bytes, not from headers.
 */

/** Image hosts of Shopee and TikTok Shop / Tokopedia, matched as the host or a subdomain of it. */
export const MARKETPLACE_IMAGE_HOSTS = [
  "susercontent.com",
  "shopee.co.id",
  "shopee.sg",
  "shopee.com",
  "shopeemobile.com",
  "ibyteimg.com",
  "byteimg.com",
  "tiktokcdn.com",
  "tiktokcdn-us.com",
  "tiktokcdn-eu.com",
  "tokopedia.net",
  "tokopedia.com",
];

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;

export interface ImageFetchConfig {
  /** Hosts besides MARKETPLACE_IMAGE_HOSTS (PRODUCT_IMAGE_HOSTS; the fake marketplace in tests). */
  extraHosts: string[];
  /** Plain http and any port: local and test only. */
  allowHttp: boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

export type ImageKind = "jpeg" | "png" | "webp" | "gif" | "bmp" | "heic";

export interface ImageInfo {
  kind: ImageKind;
  width: number | null;
  height: number | null;
}

export interface FetchedImage extends ImageInfo {
  bytes: Uint8Array;
  contentType: string;
}

export type ImageFetchProblem = "url" | "host" | "http" | "size" | "format" | "network";

export class ImageFetchError extends Error {
  constructor(
    readonly problem: ImageFetchProblem,
    message: string,
  ) {
    super(message);
    this.name = "ImageFetchError";
  }
}

const CONTENT_TYPES: Record<ImageKind, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  heic: "image/heic",
};

export function hostAllowed(url: URL, cfg: Pick<ImageFetchConfig, "extraHosts" | "allowHttp">): boolean {
  if (url.username || url.password) return false;
  if (url.protocol !== "https:" && !(cfg.allowHttp && url.protocol === "http:")) return false;
  if (url.port && !cfg.allowHttp) return false;
  const host = url.hostname.toLowerCase();
  return [...MARKETPLACE_IMAGE_HOSTS, ...cfg.extraHosts.map((h) => h.toLowerCase())].some(
    (h) => host === h || host.endsWith(`.${h}`),
  );
}

const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i]! << 24) >>> 0) + ((b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2;
      continue;
    }
    const len = u16be(b, i + 2);
    // start of frame (baseline, progressive, ...), not DHT (c4), JPG (c8), DAC (cc)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === "VP8 " && b.length >= 30) return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  if (chunk === "VP8L" && b.length >= 25) {
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X" && b.length >= 30) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  return null;
}

/** File type and pixel size from the first bytes; null when it is not an image a marketplace takes. */
export function sniffImage(b: Uint8Array): ImageInfo | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const size = jpegSize(b);
    return { kind: "jpeg", width: size?.width ?? null, height: size?.height ?? null };
  }
  if (b.length >= 24 && u32be(b, 0) === 0x89504e47 && ascii(b, 12, 4) === "IHDR") {
    return { kind: "png", width: u32be(b, 16), height: u32be(b, 20) };
  }
  if (b.length >= 16 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") {
    const size = webpSize(b);
    return { kind: "webp", width: size?.width ?? null, height: size?.height ?? null };
  }
  if (b.length >= 10 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) {
    return { kind: "gif", width: u16le(b, 6), height: u16le(b, 8) };
  }
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    const w = b[18]! | (b[19]! << 8) | (b[20]! << 16) | (b[21]! << 24);
    const h = b[22]! | (b[23]! << 8) | (b[24]! << 16) | (b[25]! << 24);
    return { kind: "bmp", width: Math.abs(w), height: Math.abs(h) };
  }
  if (b.length >= 12 && ascii(b, 4, 4) === "ftyp" && /^(heic|heix|mif1|msf1)$/.test(ascii(b, 8, 4))) {
    return { kind: "heic", width: null, height: null };
  }
  return null;
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel();
    throw new ImageFetchError("size", `Foto lebih dari ${Math.round(max / 1024 / 1024)} MB.`);
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new ImageFetchError("size", `Foto lebih dari ${Math.round(max / 1024 / 1024)} MB.`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** One image from a marketplace image host. Throws ImageFetchError with a message for the seller. */
export async function fetchImage(source: string, cfg: ImageFetchConfig): Promise<FetchedImage> {
  const doFetch = cfg.fetch ?? fetch;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new ImageFetchError("url", "Alamat foto tidak valid.");
  }
  for (let hop = 0; ; hop++) {
    if (!hostAllowed(url, cfg)) {
      throw new ImageFetchError(
        "host",
        `Foto dari ${url.hostname} tidak bisa diambil: hanya foto dari server marketplace.`,
      );
    }
    let res: Response;
    try {
      res = await doFetch(url, {
        redirect: "manual",
        headers: { accept: "image/*" },
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 20_000),
      });
    } catch (err) {
      throw new ImageFetchError("network", `Foto tidak bisa diunduh: ${(err as Error).message}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel();
      if (hop >= MAX_REDIRECTS) throw new ImageFetchError("http", "Foto dialihkan terlalu banyak kali.");
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      throw new ImageFetchError("http", `Foto tidak bisa diunduh (HTTP ${res.status}).`);
    }
    const bytes = await readCapped(res, cfg.maxBytes ?? MAX_IMAGE_BYTES);
    const info = sniffImage(bytes);
    if (!info) throw new ImageFetchError("format", "Berkas foto tidak dikenali sebagai gambar.");
    return { ...info, bytes, contentType: CONTENT_TYPES[info.kind] };
  }
}

/** Formats each marketplace's image upload takes. */
export const ACCEPTED_KINDS: Record<string, ReadonlySet<ImageKind>> = {
  shopee: new Set(["jpeg", "png"]),
  tiktokshop: new Set(["jpeg", "png", "webp", "bmp", "heic"]),
};

/**
 * Why the target marketplace would refuse this image for this use, or null. TikTok Shop wants main
 * images of 300 to 4000 px a side and size charts of at least 1024 px on the shorter side; every image at
 * least 100 px.
 */
export function imageProblem(
  img: ImageInfo,
  channel: string,
  use: "main" | "variant" | "description" | "size_chart",
): string | null {
  const accepted = ACCEPTED_KINDS[channel];
  if (accepted && !accepted.has(img.kind)) {
    return `Format ${img.kind.toUpperCase()} tidak diterima ${channel === "shopee" ? "Shopee (hanya JPG dan PNG)" : "marketplace"}. Hapus foto ini dari draf.`;
  }
  if (channel !== "tiktokshop" || img.width === null || img.height === null) return null;
  const short = Math.min(img.width, img.height);
  const long = Math.max(img.width, img.height);
  if (short < 100) return `Foto ${img.width}×${img.height} px terlalu kecil (minimal 100 px).`;
  if (use === "main" && (short < 300 || long > 4000)) {
    return `Foto utama harus 300–4000 px per sisi di Tokopedia & Shop (foto ini ${img.width}×${img.height} px).`;
  }
  if (use === "size_chart" && short < 1024) {
    return `Tabel ukuran harus minimal 1024 px di sisi terpendek (foto ini ${img.width}×${img.height} px).`;
  }
  return null;
}
