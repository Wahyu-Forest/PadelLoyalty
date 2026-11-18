export const DEFAULT_API_URL = "http://localhost:4000";

/** Normalises a configured API base URL: trims it, drops trailing slashes, applies the default. */
export function resolveApiUrl(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) return DEFAULT_API_URL;
  return value.replace(/\/+$/, "");
}

// Must reference process.env.NEXT_PUBLIC_API_URL literally so Next.js inlines it at build time.
export const apiUrl = resolveApiUrl(process.env.NEXT_PUBLIC_API_URL);
