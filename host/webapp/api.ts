import {
  applySessionSync,
  HOST_PROTOCOL_VERSION,
  type HostCommand,
  type HostSession,
  type SessionSync,
  type SessionSyncChunk,
  type SessionSyncResponse,
} from "../../src/features/connections/model/protocol";

export class Unauthorized extends Error {}

let environmentId = "";

export async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch("/web/rpc", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: HOST_PROTOCOL_VERSION, environmentId, method, params }),
  });
  const value = (await response.json().catch(() => ({}))) as { result?: T; error?: string };
  if (response.status === 401) throw new Unauthorized(value.error ?? "Signed out");
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value.result as T;
}

export async function describe<T extends { environmentId: string }>(): Promise<T> {
  const host = await rpc<T>("environment.describe", {
    supportedProviders: ["codex", "claude", "cursor", "grok", "opencode", "pi", "omp", "fx", "hermes", "antigravity", "devin"],
  });
  environmentId = host.environmentId;
  return host;
}

export async function login(token: string): Promise<void> {
  const response = await fetch("/web/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) {
    const value = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(value.error ?? `HTTP ${response.status}`);
  }
}

export async function logout(): Promise<void> {
  await fetch("/web/logout", { method: "POST", credentials: "same-origin" });
}

/** Only the blocks changed since `known`; a full snapshot when it no longer applies. */
export async function syncSession(sessionId: string, known?: HostSession): Promise<HostSession> {
  const read = async (revision?: number): Promise<SessionSync> => {
    const response = await rpc<SessionSyncResponse>("sessions.sync", { sessionId, revision });
    if (response.kind !== "chunked") return response;
    const pieces: string[] = [];
    let offset = 0;
    while (offset < response.length) {
      const { data } = await rpc<SessionSyncChunk>("sessions.syncChunk", {
        sessionId,
        transfer: response.transfer,
        offset,
      });
      if (!data) throw new Error("Session transfer ended early");
      pieces.push(data);
      offset += data.length;
    }
    return JSON.parse(pieces.join("")) as SessionSync;
  };
  try {
    return applySessionSync(known, await read(known?.revision));
  } catch (error) {
    if (!known || error instanceof Unauthorized) throw error;
    return applySessionSync(undefined, await read());
  }
}

export type CommandInput = HostCommand extends infer C
  ? C extends HostCommand
    ? Omit<C, "commandId">
    : never
  : never;

export function command(input: CommandInput) {
  return rpc<{ commandId: string; sessionId: string; revision: number }>("commands.dispatch", {
    ...input,
    commandId: crypto.randomUUID(),
  });
}
