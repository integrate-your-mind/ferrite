const DEFAULT_SITE_ORIGIN = "https://ferrite.dev";

export function getSiteOrigin(): string {
  const value = process.env.FERRITE_SITE_ORIGIN?.trim() || DEFAULT_SITE_ORIGIN;
  if (!/^https?:\/\/[^/?#\\]+\/?$/i.test(value)) {
    throw new Error("FERRITE_SITE_ORIGIN must be an HTTP or HTTPS origin without credentials, a path, query, or fragment");
  }
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("FERRITE_SITE_ORIGIN must be an HTTP or HTTPS origin without credentials, a path, query, or fragment");
  }
  return url.origin;
}

export function siteUrl(pathname: string): string {
  return new URL(pathname, getSiteOrigin() + "/").toString();
}
