export const DEFAULT_API_URL = "http://localhost:4000";

/**
 * Normalises the configured API base URL: trims it and drops trailing slashes.
 * Unset means the local development API. Set but blank means this build has
 * no API (e.g. the GitHub Pages build before an API is hosted), so `null`:
 * the app then shows the API as unreachable without making a request.
 */
export function resolveApiUrl(raw: string | undefined): string | null {
  if (raw === undefined) return DEFAULT_API_URL;
  const value = raw.trim();
  if (!value) return null;
  return value.replace(/\/+$/, "");
}

// Must reference process.env.NEXT_PUBLIC_API_URL literally so Next.js inlines it at build time.
export const apiUrl = resolveApiUrl(process.env.NEXT_PUBLIC_API_URL);
