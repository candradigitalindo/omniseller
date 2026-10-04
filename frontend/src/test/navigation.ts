import { useMemo, useSyncExternalStore } from "react";
import { vi } from "vitest";

/**
 * In-memory stand-in for `next/navigation` (setup.ts mocks the module with it): the URL lives here, the
 * router changes it, and components re-render as they would after a client-side navigation.
 */
let url = new URL("http://localhost:3000/");
const listeners = new Set<() => void>();

function go(href: string) {
  url = new URL(href, url);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const testRouter = {
  push: vi.fn(go),
  replace: vi.fn(go),
  back: vi.fn(),
  forward: vi.fn(),
  refresh: vi.fn(),
  prefetch: vi.fn(),
};

/** Where the app "is" now, path and query (`/pesanan?status=new`). */
export function currentUrl(): string {
  return url.pathname + url.search;
}

export function setUrl(href: string): void {
  url = new URL(href, "http://localhost:3000/");
  testRouter.push.mockClear();
  testRouter.replace.mockClear();
  for (const listener of listeners) listener();
}

export function useRouter() {
  return testRouter;
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => url.pathname);
}

export function useSearchParams(): URLSearchParams {
  const search = useSyncExternalStore(subscribe, () => url.search);
  return useMemo(() => new URLSearchParams(search), [search]);
}

export function redirect(href: string): never {
  throw new Error(`redirect(${href})`);
}

export function notFound(): never {
  throw new Error("notFound()");
}
