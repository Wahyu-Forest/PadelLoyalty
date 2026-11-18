/**
 * Normalises NEXT_PUBLIC_BASE_PATH, the URL path the static export is served
 * under. Unset or blank means the root: the Capacitor apps and local builds.
 * The GitHub Pages workflow sets it to /PadelLoyalty (a project site).
 */
export function resolveBasePath(raw: string | undefined): string {
  const value = raw?.trim() ?? "";
  if (value.includes("://")) {
    throw new Error(
      `NEXT_PUBLIC_BASE_PATH must be a path such as /PadelLoyalty, not a URL (got "${value}")`,
    );
  }
  const segments = value.split("/").filter((segment) => segment.length > 0);
  return segments.length === 0 ? "" : `/${segments.join("/")}`;
}
