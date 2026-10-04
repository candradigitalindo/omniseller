/**
 * A full page load to another address (a marketplace's consent page, the sign-in page after the session
 * ended). Kept in one place so tests can replace it: jsdom cannot navigate.
 */
export function leaveTo(url: string): void {
  window.location.assign(url);
}
