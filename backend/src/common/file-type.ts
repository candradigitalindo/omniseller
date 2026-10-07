/** A file's type read from its first bytes, never from the name or the browser's claim. */
export interface SniffedType {
  mime: "application/pdf" | "image/png" | "image/jpeg" | "image/webp";
  ext: "pdf" | "png" | "jpg" | "webp";
}

const starts = (b: Uint8Array, sig: readonly number[], at = 0) => sig.every((x, i) => b[at + i] === x);

export function sniffFileType(bytes: Uint8Array): SniffedType | null {
  if (starts(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { mime: "application/pdf", ext: "pdf" }; // %PDF-
  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { mime: "image/png", ext: "png" };
  if (starts(bytes, [0xff, 0xd8, 0xff])) return { mime: "image/jpeg", ext: "jpg" };
  // RIFF....WEBP
  if (starts(bytes, [0x52, 0x49, 0x46, 0x46]) && starts(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}
