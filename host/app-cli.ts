import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import usage from "./app-cli-usage.txt?raw";

/**
 * `monocode-host app …`: the sIDE app CLI for an agent the host runs. Same
 * arguments, output and help as the desktop's own (`control_cli.rs`); calls
 * go to this host, which relays them to the desktop showing the session.
 */

type Parsed =
  | { kind: "help" }
  | { kind: "call"; action: string; input: Record<string, unknown>; requestId: string };

const MAX_INPUT = 256 * 1024;

export function parseAppArgs(args: readonly string[], stdin: () => string): Parsed {
  const [action, ...rest] = args;
  if (!action || ["help", "--help", "-h"].includes(action)) return { kind: "help" };
  let raw: string | undefined;
  let requestId: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (["help", "--help", "-h"].includes(flag)) return { kind: "help" };
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === "--json") {
      if (raw !== undefined) throw new Error("Pass only one of --json or --input");
      raw = value;
    } else if (flag === "--input") {
      if (raw !== undefined) throw new Error("Pass only one of --json or --input");
      raw = value === "-" ? stdin() : readFileSync(value, "utf8");
    } else if (flag === "--request-id") {
      requestId = value;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
    i++;
  }
  if (raw !== undefined && Buffer.byteLength(raw) > MAX_INPUT) throw new Error("Input exceeds 256 KiB");
  const input: unknown = raw === undefined ? {} : JSON.parse(raw);
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Input must be a JSON object");
  requestId ??= randomUUID();
  if (!requestId || requestId.length > 128) throw new Error("Invalid request ID");
  return { kind: "call", action, input: input as Record<string, unknown>, requestId };
}

export function appHelp(exe = process.env.MONOCODE_APP_CLI || "monocode-host"): string {
  return usage.replaceAll("{exe} app", exe.endsWith(" app") ? exe : `${exe} app`);
}

export async function runAppCli(
  args: readonly string[],
  out: (line: string) => void = (line) => console.log(line),
  stdin: () => string = () => readFileSync(0, "utf8"),
): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parseAppArgs(args, stdin);
  } catch (error) {
    out(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return 1;
  }
  if (parsed.kind === "help") {
    out(appHelp());
    return 0;
  }
  const endpoint = process.env.MONOCODE_APP_ENDPOINT;
  const token = process.env.MONOCODE_APP_TOKEN;
  if (!endpoint) {
    out(JSON.stringify({ ok: false, error: "No sIDE app connection. Start this agent turn in sIDE." }));
    return 1;
  }
  if (!token) {
    out(JSON.stringify({ ok: false, error: "No sIDE session credential. Start the agent from sIDE." }));
    return 1;
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//.test(endpoint) ? endpoint : `http://${endpoint}/app`);
  } catch {
    out(JSON.stringify({ ok: false, error: "Invalid sIDE endpoint" }));
    return 1;
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    out(JSON.stringify({ ok: false, error: "sIDE control only connects to localhost" }));
    return 1;
  }
  let response: Record<string, unknown>;
  try {
    const reply = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, action: parsed.action, input: parsed.input, requestId: parsed.requestId }),
      signal: AbortSignal.timeout(40_000),
    });
    response = (await reply.json()) as Record<string, unknown>;
  } catch (error) {
    // Sent or not, the outcome is unknown: the same ID makes a retry safe.
    out(JSON.stringify({
      ok: false,
      error: `No reply from sIDE: ${error instanceof Error ? error.message : String(error)}`,
      requestId: parsed.requestId,
    }));
    return 1;
  }
  out(JSON.stringify(response));
  return response.ok === true ? 0 : 1;
}
