/**
 * Where to go after logging in, from a `?next=` parameter (#56: the back
 * office sends staff to log in and back). Only same-app paths are allowed, so
 * the parameter can't send someone to another site.
 */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
  if (/[\\\s]/.test(value) || value.includes("://")) return null;
  return value;
}
