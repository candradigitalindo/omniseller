import type { HttpConfig } from "@omniseller/connector-core";

const refused = (code: string) =>
  new Response(JSON.stringify({ error: code, message: "Shopee file transfer refused" }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });

/** Redirects never expand the trusted API origin or forward credentials to a document-supplied URL. */
export function commerceDownloadFetch(baseUrl: string, http: HttpConfig | undefined): typeof fetch {
  const origin = new URL(baseUrl).origin;
  return (async (input, init = {}) => {
    let url = new URL(String(input));
    let options: RequestInit = { ...init, redirect: "manual" };
    for (let redirects = 0; redirects <= 3; redirects++) {
      if (url.origin !== origin) return refused("commerce_untrusted_redirect");
      if (redirects > 0) await http?.beforeRequest?.();
      const response = await (http?.fetch ?? fetch)(url, options);
      if (![301, 302, 303, 307, 308].includes(response.status)) {
        const length = Number(response.headers.get("content-length"));
        if (Number.isFinite(length) && length > 20 * 1024 * 1024) return refused("commerce_file_too_large");
        const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
        if (type && !["application/pdf", "application/octet-stream", "application/json"].includes(type))
          return refused("commerce_file_type");
        return response;
      }
      const location = response.headers.get("location");
      if (!location || redirects === 3) return refused("commerce_redirect_limit");
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return refused("commerce_untrusted_redirect");
      }
      if (next.origin !== origin || next.username || next.password) return refused("commerce_untrusted_redirect");
      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) && options.method === "POST")
      ) {
        options = { ...options, method: "GET", body: undefined };
      }
      url = next;
    }
    return refused("commerce_redirect_limit");
  }) as typeof fetch;
}
