import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  createServer,
  request as forward,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from "node:http";
import type { Duplex } from "node:stream";
import { delimiter, join } from "node:path";
import { localTarget } from "../src/features/connections/model/localTarget";

/**
 * Previews of this machine's local web servers for the other devices: an
 * agent's `http://localhost:5173` opens on the laptop or the phone as
 * `https://<this machine>.ts.net:5173`.
 *
 * `tailscale serve` publishes each opened port on the tailnet only, and every
 * one of them points at a single proxy here, which reads the port back from
 * the Host header and forwards to `localhost:<port>` as `localhost`. Dev
 * servers that only answer their own host name (Vite) need no setting.
 *
 * The tailnet is the first gate; a token is the second. A preview link
 * carries it once, and the proxy trades it for a cookie on that host.
 */

const STATE = "previews.json";
const COOKIE = "side_preview";
const PARAM = "side-preview";
/** The browser app's credential; never forwarded to a dev server. */
const WEB_COOKIE = "side_host";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_PORTS = 50;
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60;

/** Runs the `tailscale` CLI and returns its standard output. */
export type TailscaleRunner = (args: string[]) => Promise<string>;

type State = { token: string; ports: number[] };

/** The tailscale CLI: on PATH, from Homebrew, or inside the macOS app. */
export function findTailscale(): string | undefined {
  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ];
  const candidates = [
    ...dirs.map((dir) => join(dir, "tailscale")),
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  ];
  return candidates.find((path) => existsSync(path));
}

export function tailscaleRunner(binary: string): TailscaleRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(binary, args, { timeout: 15_000 }, (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr).trim() || error.message));
        else resolve(String(stdout));
      });
    });
}

function portParam(value: unknown): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65_535)
    throw new Error("Previews need a local port between 1024 and 65535");
  return port;
}

function pathParam(value: unknown): string {
  if (value === undefined) return "/";
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.length > 2_000)
    throw new Error("Invalid preview path");
  return value;
}

function cookies(header: string | undefined): [string, string][] {
  return (header ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const at = part.indexOf("=");
      return at < 0 ? [part, ""] : [part.slice(0, at), part.slice(at + 1)];
    });
}

function sameToken(a: string | undefined, b: string): boolean {
  if (!a || !TOKEN.test(a)) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** The port the browser asked for: Tailscale keeps it in the Host header. */
function requestedPort(request: IncomingMessage): number | undefined {
  const host = request.headers.host ?? "";
  const match = host.match(/:(\d{1,5})$/);
  return match ? Number(match[1]) : undefined;
}

function upstreamHeaders(headers: IncomingHttpHeaders, port: number): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.startsWith("tailscale-") || name.startsWith("x-forwarded-")) continue;
    out[name] = value;
  }
  out.host = `localhost:${port}`;
  if (headers.origin) out.origin = `http://localhost:${port}`;
  if (headers.referer) {
    try {
      const referer = new URL(headers.referer);
      out.referer = `http://localhost:${port}${referer.pathname}${referer.search}`;
    } catch {
      delete out.referer;
    }
  }
  const kept = cookies(headers.cookie).filter(([name]) => name !== COOKIE && name !== WEB_COOKIE);
  if (kept.length) out.cookie = kept.map(([name, value]) => `${name}=${value}`).join("; ");
  else delete out.cookie;
  return out;
}

/** A redirect to the dev server's own address stays on the preview. */
function downstreamHeaders(headers: IncomingHttpHeaders, port: number): IncomingHttpHeaders {
  const location = headers.location;
  if (!location) return headers;
  const target = localTarget(location);
  return target?.port === port ? { ...headers, location: target.path } : headers;
}

export class HostPreviews {
  private state: State;
  private server?: Server;

  constructor(
    private readonly directory: string,
    private readonly proxyPort: number,
    private readonly tailscale: TailscaleRunner,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.state = this.read() ?? { token: randomBytes(32).toString("base64url"), ports: [] };
    this.write();
  }

  /** Starts the proxy every published port points at. */
  listen(): Promise<void> {
    const server = createServer((request, response) => {
      const port = requestedPort(request);
      if (!port || !this.state.ports.includes(port)) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("No preview on this port");
        return;
      }
      const url = new URL(request.url ?? "/", "http://preview");
      const offered = url.searchParams.get(PARAM);
      if (offered !== null) {
        url.searchParams.delete(PARAM);
        if (!sameToken(offered, this.state.token)) {
          response.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" }).end("This preview link has expired");
          return;
        }
        response
          .writeHead(302, {
            Location: `${url.pathname}${url.search}`,
            "Set-Cookie": `${COOKIE}=${this.state.token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`,
            "Cache-Control": "no-store",
          })
          .end();
        return;
      }
      if (!this.authorized(request)) {
        response
          .writeHead(401, { "Content-Type": "text/plain; charset=utf-8" })
          .end("Open this preview from its link in sIDE");
        return;
      }
      const upstream = forward(
        { host: "localhost", port, method: request.method, path: request.url, headers: upstreamHeaders(request.headers, port) },
        (reply) => {
          response.writeHead(reply.statusCode ?? 502, downstreamHeaders(reply.headers, port));
          reply.pipe(response);
        },
      );
      upstream.on("error", () => {
        if (response.headersSent) response.destroy();
        else
          response
            .writeHead(502, { "Content-Type": "text/plain; charset=utf-8" })
            .end(`Nothing answers on localhost:${port} on this machine`);
      });
      request.pipe(upstream);
    });
    server.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.proxyPort, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  }

  close(): void {
    this.server?.close();
    this.server?.closeAllConnections();
  }

  /** Publishes `port` on the tailnet and returns the link that opens it. */
  async open(params: Record<string, unknown>): Promise<{ url: string }> {
    const port = portParam(params.port);
    const path = pathParam(params.path);
    if (port === this.proxyPort) throw new Error("This port is the preview proxy itself");
    if (!this.state.ports.includes(port) && this.state.ports.length >= MAX_PORTS)
      throw new Error("Too many previews on this machine");
    const status = JSON.parse(await this.tailscale(["status", "--json"])) as { Self?: { DNSName?: string } };
    const name = status.Self?.DNSName?.replace(/\.$/, "");
    if (!name) throw new Error("This machine is not signed in to Tailscale");
    await this.tailscale(["serve", "--bg", `--https=${port}`, `http://127.0.0.1:${this.proxyPort}`]);
    if (!this.state.ports.includes(port)) {
      this.state.ports.push(port);
      this.write();
    }
    const url = new URL(path, `https://${name}:${port}`);
    url.searchParams.set(PARAM, this.state.token);
    return { url: url.href };
  }

  private authorized(request: IncomingMessage): boolean {
    const value = cookies(request.headers.cookie).find(([name]) => name === COOKIE)?.[1];
    return sameToken(value, this.state.token);
  }

  private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const port = requestedPort(request);
    if (!port || !this.state.ports.includes(port) || !this.authorized(request)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    const upstream = forward({
      host: "localhost",
      port,
      method: request.method,
      path: request.url,
      headers: upstreamHeaders(request.headers, port),
    });
    upstream.on("upgrade", (reply, upstreamSocket, upstreamHead) => {
      const lines = [`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}`];
      for (let i = 0; i < reply.rawHeaders.length; i += 2) lines.push(`${reply.rawHeaders[i]}: ${reply.rawHeaders[i + 1]}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (upstreamHead.length) socket.write(upstreamHead);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
      upstreamSocket.on("error", () => socket.destroy());
      socket.on("error", () => upstreamSocket.destroy());
    });
    upstream.on("response", (reply) => {
      socket.end(`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\nConnection: close\r\n\r\n`);
      reply.resume();
    });
    upstream.on("error", () => socket.destroy());
    if (head.length) upstream.write(head);
    upstream.end();
  }

  private read(): State | undefined {
    try {
      const state = JSON.parse(readFileSync(join(this.directory, STATE), "utf8")) as State;
      if (!TOKEN.test(state.token) || !Array.isArray(state.ports)) return undefined;
      return { token: state.token, ports: state.ports.filter((port) => Number.isInteger(port)).slice(0, MAX_PORTS) };
    } catch {
      return undefined;
    }
  }

  private write(): void {
    writeFileSync(join(this.directory, STATE), JSON.stringify(this.state), { mode: 0o600 });
  }
}
