import { afterEach, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { appHelp, parseAppArgs, runAppCli } from "./app-cli";

const servers: Server[] = [];
const saved = { ...process.env };
afterEach(async () => {
  process.env = { ...saved };
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done));
});

it("parses the same arguments as the desktop's app CLI", () => {
  expect(parseAppArgs([], () => "")).toEqual({ kind: "help" });
  expect(parseAppArgs(["sessions.list", "--help"], () => "")).toEqual({ kind: "help" });
  expect(parseAppArgs(["sessions.read", "--json", '{"sessionId":"x"}', "--request-id", "r"], () => ""))
    .toEqual({ kind: "call", action: "sessions.read", input: { sessionId: "x" }, requestId: "r" });
  expect(parseAppArgs(["notes.write", "--input", "-"], () => '{"body":"hi"}')).toMatchObject({
    input: { body: "hi" },
  });
  expect(() => parseAppArgs(["x", "--json", "[]"], () => "")).toThrow("JSON object");
  expect(() => parseAppArgs(["x", "--json", "{}", "--input", "-"], () => "{}")).toThrow("only one");
  expect(() => parseAppArgs(["x", "--wat", "1"], () => "")).toThrow("Unknown argument");
});

it("takes a lone JSON object as the input, the way Colleague prompts write it", () => {
  expect(parseAppArgs(["memory.search", '{"query":"linear"}', "--request-id", "r"], () => ""))
    .toEqual({ kind: "call", action: "memory.search", input: { query: "linear" }, requestId: "r" });
  expect(() => parseAppArgs(["x", "{}", "--json", "{}"], () => "")).toThrow("only one");
  expect(() => parseAppArgs(["x", "query"], () => "")).toThrow();
});

it("prints help naming this host's command", () => {
  const help = appHelp("/home/me/.side-host/bin/side-host app");
  expect(help).toContain("Usage: /home/me/.side-host/bin/side-host app ACTION");
  expect(help).toContain("sessions.start");
});

it("sends a call to the host and prints its answer", async () => {
  let received: any;
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      received = { url: request.url, body: JSON.parse(text) };
      response.end(JSON.stringify({ ok: true, result: { sessions: [] } }));
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  process.env.MONOCODE_APP_ENDPOINT = `http://127.0.0.1:${(server.address() as AddressInfo).port}/app`;
  process.env.MONOCODE_APP_TOKEN = "secret";
  const lines: string[] = [];
  expect(await runAppCli(["sessions.list", "--request-id", "r9"], (line) => lines.push(line))).toBe(0);
  expect(received).toEqual({
    url: "/app",
    body: { token: "secret", action: "sessions.list", input: {}, requestId: "r9" },
  });
  expect(JSON.parse(lines[0])).toEqual({ ok: true, result: { sessions: [] } });
});

it("explains a missing connection and refuses non-loopback endpoints", async () => {
  delete process.env.MONOCODE_APP_ENDPOINT;
  const lines: string[] = [];
  expect(await runAppCli(["sessions.list"], (line) => lines.push(line))).toBe(1);
  expect(lines[0]).toContain("No sIDE app connection");
  process.env.MONOCODE_APP_ENDPOINT = "http://example.com/app";
  process.env.MONOCODE_APP_TOKEN = "t";
  expect(await runAppCli(["sessions.list"], (line) => lines.push(line))).toBe(1);
  expect(lines[1]).toContain("localhost");
});
