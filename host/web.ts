import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** The browser app's files, next to the host bundle (`build/host/web`, or
 * `web` in a packaged host). */
export const DEFAULT_WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "web");

const COOKIE = "side_host";
/** Compressed files by path, kept until the file changes. */
const compressed = new Map<string, { source: Buffer; gzip: Buffer }>();
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

export function webSecurityHeaders(response: ServerResponse) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
}

/** A browser request from the page this host served. Behind a reverse proxy
 * (`tailscale serve`) the public name arrives as `X-Forwarded-Host`. */
export function sameOrigin(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const forwarded = request.headers["x-forwarded-host"];
  return [request.headers.host, ...(Array.isArray(forwarded) ? forwarded : [forwarded])]
    .some((value) => value === host);
}

/** The device credential the browser keeps in its cookie. */
export function webToken(request: IncomingMessage): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === COOKIE && value && TOKEN.test(value)) return value;
  }
  return undefined;
}

function cookie(request: IncomingMessage, value: string, maxAge: number): string {
  // Over loopback HTTP during development the cookie cannot be Secure.
  const secure =
    request.headers["x-forwarded-proto"] === "https" ||
    request.headers.origin?.startsWith("https://");
  return `${COOKIE}=${value}; Path=/web; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

async function json(request: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) {
    text += String(chunk);
    if (text.length > 1024) throw new Error("Request is too large");
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
  return value as Record<string, unknown>;
}

/** The browser app: its files, and signing in with a device credential.
 * `/web/rpc` itself is answered by the host's RPC handler. */
export async function serveWeb(
  request: IncomingMessage,
  response: ServerResponse,
  authenticated: (token: string) => boolean,
  root = DEFAULT_WEB_ROOT,
) {
  webSecurityHeaders(response);
  response.setHeader("Cache-Control", "no-store");
  const path = (request.url ?? "").split("?")[0];
  if (request.method === "POST" && (path === "/web/login" || path === "/web/logout")) {
    response.setHeader("Content-Type", "application/json");
    if (!sameOrigin(request)) {
      response.writeHead(403).end(JSON.stringify({ error: "Unsupported request origin" }));
      return;
    }
    if (path === "/web/logout") {
      response.setHeader("Set-Cookie", cookie(request, "", 0));
      response.end("{}");
      return;
    }
    let token: unknown;
    try {
      token = (await json(request)).token;
    } catch {
      response.writeHead(400).end(JSON.stringify({ error: "Invalid request" }));
      return;
    }
    if (typeof token !== "string" || !TOKEN.test(token.trim()) || !authenticated(token.trim())) {
      response.writeHead(401).end(JSON.stringify({ error: "Device credential is invalid or revoked" }));
      return;
    }
    response.setHeader("Set-Cookie", cookie(request, token.trim(), COOKIE_MAX_AGE));
    response.end("{}");
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405).end();
    return;
  }
  if (path === "/web") {
    response.writeHead(308, { Location: "/web/" }).end();
    return;
  }
  const name = path === "/web/" ? "index.html" : path.slice("/web/".length);
  if (!/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name) || !TYPES[extname(name)]) {
    response.writeHead(404).end();
    return;
  }
  try {
    const location = join(root, name);
    let file = await readFile(location);
    const headers: Record<string, string> = { "Content-Type": TYPES[extname(name)], Vary: "Accept-Encoding" };
    if (/\bgzip\b/.test(String(request.headers["accept-encoding"] ?? "")) && extname(name) !== ".png") {
      let cached = compressed.get(location);
      if (!cached?.source.equals(file)) compressed.set(location, (cached = { source: file, gzip: gzipSync(file) }));
      file = cached.gzip;
      headers["Content-Encoding"] = "gzip";
    }
    response.writeHead(200, headers);
    response.end(request.method === "HEAD" ? undefined : file);
  } catch {
    response.writeHead(404).end();
  }
}
