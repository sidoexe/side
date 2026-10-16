/** The port and path a `localhost` link points at, or undefined for any
 * other address. */
export function localTarget(href: string): { port: number; path: string } | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (!["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"].includes(url.hostname)) return undefined;
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  return { port, path: `${url.pathname}${url.search}${url.hash}` };
}
