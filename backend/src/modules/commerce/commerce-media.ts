/** Detect permitted media from bytes; the browser's Content-Type and filename are untrusted. */
export function commerceMediaType(bytes: Uint8Array): { mime: string; ext: string } | null {
  const b = Buffer.from(bytes);
  const text = (start: number, end: number) => b.toString("latin1", start, end);
  if (b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { mime: "image/jpeg", ext: "jpg" };
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: "image/png", ext: "png" };
  if (["GIF87a", "GIF89a"].includes(text(0, 6))) return { mime: "image/gif", ext: "gif" };
  if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") return { mime: "image/webp", ext: "webp" };
  if (text(0, 2) === "BM") return { mime: "image/bmp", ext: "bmp" };
  if (text(0, 5) === "%PDF-") return { mime: "application/pdf", ext: "pdf" };
  if (text(4, 8) === "ftyp") {
    const brand = text(8, 12);
    if (/^(?:heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return { mime: "image/heic", ext: "heic" };
    if (brand === "qt  ") return { mime: "video/quicktime", ext: "mov" };
    if (brand.startsWith("3g")) return { mime: "video/3gpp", ext: "3gp" };
    if (
      ["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "M4V ", "MSNV"].includes(brand)
    )
      return { mime: "video/mp4", ext: "mp4" };
    return null;
  }
  if (text(0, 4) === "RIFF" && text(8, 12) === "AVI ") return { mime: "video/x-msvideo", ext: "avi" };
  if (b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
    return text(0, 128).includes("webm")
      ? { mime: "video/webm", ext: "webm" }
      : { mime: "video/x-matroska", ext: "mkv" };
  if (text(0, 3) === "FLV") return { mime: "video/x-flv", ext: "flv" };
  if (b.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0xba])) || b.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0xb3])))
    return { mime: "video/mpeg", ext: "mpeg" };
  if (b.subarray(0, 16).equals(Buffer.from("3026b2758e66cf11a6d900aa0062ce6c", "hex")))
    return { mime: "video/x-ms-wmv", ext: "wmv" };
  return null;
}
