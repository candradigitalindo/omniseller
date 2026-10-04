/** Where to go after signing in: a path of this app only, never another site (`//evil.example`). */
export function safeNext(next: string | null | undefined): string {
  if (!next?.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return "/";
  return next;
}

/** A rough password strength for the signup hint: length and character variety. */
export function passwordStrength(password: string): "weak" | "fair" | "strong" {
  if (password.length < 10) return "weak";
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (password.length >= 14 && kinds >= 3) return "strong";
  return kinds >= 2 ? "fair" : "weak";
}
