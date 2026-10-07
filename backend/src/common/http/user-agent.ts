/**
 * Browser and system from a User-Agent, for the list of signed-in devices (backend doc 8.30): enough
 * for a person to recognise "Chrome di macOS", nothing more. Unknown agents give nulls. The order
 * matters: Edge and Opera also say Chrome, and Chrome also says Safari.
 */
export function describeUserAgent(ua: string | undefined): { browser: string | null; os: string | null } {
  if (!ua) return { browser: null, os: null };
  const browser = /Edg(?:e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /SamsungBrowser\//.test(ua)
        ? "Samsung Internet"
        : /Firefox\/|FxiOS\//.test(ua)
          ? "Firefox"
          : /Chrome\/|CriOS\//.test(ua)
            ? "Chrome"
            : /Version\/[\d.]+.*Safari\//.test(ua)
              ? "Safari"
              : null;
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /CrOS/.test(ua)
        ? "ChromeOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Mac OS X|Macintosh/.test(ua)
            ? "macOS"
            : /Linux/.test(ua)
              ? "Linux"
              : null;
  return { browser, os };
}
