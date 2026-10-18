const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const MAX_ALLOWED_ORIGINS = 32;

export const isLoopbackOrigin = (origin: string): boolean => {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname);
  } catch {
    return false;
  }
};

/** Return an HTTP(S) page URL, or undefined when it is not one. */
export const isHttpUrl = (value: string): URL | undefined => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === ""
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

/** Normalize one exact HTTP(S) origin, rejecting wildcards and URL decorations. */
export const parseExactOrigin = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new Error(`"${value}" is not a valid origin.`, { cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`"${value}" must use http or https.`);
  if (url.origin === "null" || url.hostname === "") throw new Error(`"${value}" has no origin.`);
  if (url.username !== "" || url.password !== "")
    throw new Error(`"${value}" must not include credentials.`);
  if (url.search !== "" || url.hash !== "")
    throw new Error(`"${value}" must not include a query or fragment.`);
  if (url.pathname !== "/") throw new Error(`"${value}" must be an origin without a path.`);
  if (url.hostname.includes("*")) throw new Error(`"${value}" must not contain a wildcard.`);
  return url.origin;
};

/** Authorize the selected page origin plus any explicitly requested origins. */
export const buildAllowedOrigins = (
  targetOrigin: string,
  requested: readonly string[],
): ReadonlySet<string> => {
  const origins = new Set<string>([targetOrigin]);
  for (const value of requested) origins.add(parseExactOrigin(value));
  if (origins.size > MAX_ALLOWED_ORIGINS)
    throw new Error(`At most ${String(MAX_ALLOWED_ORIGINS)} distinct origins may be authorized.`);
  return origins;
};
