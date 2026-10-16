import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostPreviews } from "./previews";
import { localTarget } from "../src/features/connections/model/localTarget";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function directory() {
  const dir = mkdtempSync(join(tmpdir(), "side-previews-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function listening(server: Server, port = 0): Promise<number> {
  return new Promise((resolve) =>
    server.listen(port, "127.0.0.1", () => {
      cleanups.push(() => {
        server.close();
        server.closeAllConnections();
      });
      resolve((server.address() as AddressInfo).port);
    }),
  );
}

async function freePort(): Promise<number> {
  const server = createServer();
  const port = await listening(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A dev server that echoes what reached it. */
async function devServer(): Promise<number> {
  const server = createServer((req, res) => {
    if (req.url === "/moved") {
      res.writeHead(302, { Location: `http://localhost:${port}/there?x=1` }).end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ url: req.url, headers: req.headers }));
  });
  server.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (data) => socket.write(`echo:${data}`));
  });
  const port = await listening(server);
  return port;
}

async function previews(tailscale: string[][] = []) {
  const proxyPort = await freePort();
  const host = new HostPreviews(directory(), proxyPort, async (args) => {
    tailscale.push(args);
    return args[0] === "status" ? JSON.stringify({ Self: { DNSName: "mac.tail.ts.net." } }) : "";
  });
  await host.listen();
  cleanups.push(() => host.close());
  return { host, proxyPort };
}

function get(
  proxyPort: number,
  port: number,
  path: string,
  headers: IncomingHttpHeaders = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: proxyPort, path, headers: { ...headers, host: `mac.tail.ts.net:${port}` } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("previews", () => {
  it("publishes the port through Tailscale and links to it with a token", async () => {
    const calls: string[][] = [];
    const { host, proxyPort } = await previews(calls);
    const { url } = await host.open({ port: 5173, path: "/videos/043?lang=fr" });
    const link = new URL(url);
    expect(link.origin).toBe("https://mac.tail.ts.net:5173");
    expect(link.pathname + "?lang=" + link.searchParams.get("lang")).toBe("/videos/043?lang=fr");
    expect(link.searchParams.get("side-preview")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(calls).toContainEqual(["serve", "--bg", "--https=5173", `http://127.0.0.1:${proxyPort}`]);
  });

  it("refuses ports it cannot publish", async () => {
    const { host, proxyPort } = await previews();
    await expect(host.open({ port: 80 })).rejects.toThrow();
    await expect(host.open({ port: "abc" })).rejects.toThrow();
    await expect(host.open({ port: proxyPort })).rejects.toThrow();
    await expect(host.open({ port: 5173, path: "//evil.example" })).rejects.toThrow();
  });

  it("trades the link's token for a cookie, then forwards as localhost", async () => {
    const { host, proxyPort } = await previews();
    const port = await devServer();
    const token = new URL((await host.open({ port, path: "/a?b=1" })).url).searchParams.get("side-preview")!;

    expect((await get(proxyPort, port, "/a")).status).toBe(401);
    expect((await get(proxyPort, port, `/a?b=1&side-preview=wrong`)).status).toBe(401);

    const signed = await get(proxyPort, port, `/a?b=1&side-preview=${token}`);
    expect(signed.status).toBe(302);
    expect(signed.headers.location).toBe("/a?b=1");
    expect(String(signed.headers["set-cookie"])).toContain("HttpOnly");

    const cookie = `side_preview=${token}; side_host=secret; theme=dark`;
    const reply = await get(proxyPort, port, "/a?b=1", { cookie, origin: `https://mac.tail.ts.net:${port}` });
    const echoed = JSON.parse(reply.body) as { url: string; headers: IncomingHttpHeaders };
    expect(echoed.url).toBe("/a?b=1");
    expect(echoed.headers.host).toBe(`localhost:${port}`);
    expect(echoed.headers.origin).toBe(`http://localhost:${port}`);
    expect(echoed.headers.cookie).toBe("theme=dark");

    const moved = await get(proxyPort, port, "/moved", { cookie });
    expect(moved.headers.location).toBe("/there?x=1");
  });

  it("answers only for opened ports", async () => {
    const { proxyPort } = await previews();
    expect((await get(proxyPort, 5999, "/")).status).toBe(404);
  });

  it("says when nothing runs on the port", async () => {
    const { host, proxyPort } = await previews();
    const port = await freePort();
    const token = new URL((await host.open({ port })).url).searchParams.get("side-preview")!;
    const reply = await get(proxyPort, port, "/", { cookie: `side_preview=${token}` });
    expect(reply.status).toBe(502);
  });

  it("carries websockets for hot reload", async () => {
    const { host, proxyPort } = await previews();
    const port = await devServer();
    const token = new URL((await host.open({ port })).url).searchParams.get("side-preview")!;
    const socket = connect(proxyPort, "127.0.0.1");
    cleanups.push(() => socket.destroy());
    const received: string[] = [];
    socket.on("data", (data) => received.push(String(data)));
    socket.write(
      `GET /hmr HTTP/1.1\r\nHost: mac.tail.ts.net:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: side_preview=${token}\r\n\r\n`,
    );
    await expect.poll(() => received.join("")).toContain("101 Switching Protocols");
    socket.write("ping");
    await expect.poll(() => received.join("")).toContain("echo:ping");
  });

  it("keeps its token and ports across restarts, readable by this user only", async () => {
    const dir = directory();
    const run = async () => JSON.stringify({ Self: { DNSName: "mac.tail.ts.net." } });
    const first = new HostPreviews(dir, 1, run);
    const url = (await first.open({ port: 5173 })).url;
    expect(statSync(join(dir, "previews.json")).mode & 0o777).toBe(0o600);
    expect((await new HostPreviews(dir, 1, run).open({ port: 5173 })).url).toBe(url);
  });
});

describe("localTarget", () => {
  it("reads local links only", () => {
    expect(localTarget("http://localhost:5173/a?b#c")).toEqual({ port: 5173, path: "/a?b#c" });
    expect(localTarget("http://127.0.0.1:3000")).toEqual({ port: 3000, path: "/" });
    expect(localTarget("http://[::1]:8080/x")).toEqual({ port: 8080, path: "/x" });
    expect(localTarget("http://localhost/")).toEqual({ port: 80, path: "/" });
    expect(localTarget("https://example.com:5173/")).toBeUndefined();
    expect(localTarget("file:///etc/passwd")).toBeUndefined();
    expect(localTarget("not a url")).toBeUndefined();
  });
});
