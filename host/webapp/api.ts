import {
  applySessionSync,
  HOST_PROTOCOL_VERSION,
  type HostSession as ProtocolSession,
  type SessionSync,
  type SessionSyncChunk,
  type SessionSyncResponse,
} from "../../src/features/connections/model/protocol";
import type { Attachment, HostDescriptor, HostSession } from "./model";

export class Unauthorized extends Error {}

/** The host that serves this page. Every other machine is reached through
 * it, at `/web/machines/<id>/rpc`, with the credential it keeps. */
export const LOCAL = "local";

/** Each machine's identity, which every call names. */
const environments = new Map<string, string>();

export async function rpc<T>(method: string, params: Record<string, unknown> = {}, machine = LOCAL): Promise<T> {
  // Every call names the host it expects; learn it first.
  if (!environments.has(machine) && method !== "environment.describe") await describe(machine);
  const response = await fetch(machine === LOCAL ? "/web/rpc" : `/web/machines/${encodeURIComponent(machine)}/rpc`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: HOST_PROTOCOL_VERSION, environmentId: environments.get(machine) ?? "", method, params }),
  });
  const value = (await response.json().catch(() => ({}))) as { result?: T; error?: string };
  // Only this page's own host can sign it out; another machine's refusal
  // reaches it as an ordinary error.
  if (response.status === 401 && machine === LOCAL) throw new Unauthorized(value.error ?? "Signed out");
  if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
  return value.result as T;
}

export async function describe(machine = LOCAL): Promise<HostDescriptor> {
  const host = await rpc<HostDescriptor>(
    "environment.describe",
    { supportedProviders: ["codex", "claude", "cursor", "grok", "opencode", "pi", "omp", "fx", "hermes", "antigravity", "devin"] },
    machine,
  );
  if (host.protocolVersion !== HOST_PROTOCOL_VERSION) throw new Error("This machine is running an incompatible sIDE Host");
  environments.set(machine, host.environmentId);
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
  environments.clear();
  await fetch("/web/logout", { method: "POST", credentials: "same-origin" });
}

/** Only the blocks changed since `known`; a full snapshot when it no longer applies. */
export async function syncSession(machine: string, sessionId: string, known?: HostSession): Promise<HostSession> {
  const read = async (revision?: number): Promise<SessionSync> => {
    const response = await rpc<SessionSyncResponse>("sessions.sync", { sessionId, revision }, machine);
    if (response.kind !== "chunked") return response;
    const pieces: string[] = [];
    let offset = 0;
    while (offset < response.length) {
      const { data } = await rpc<SessionSyncChunk>("sessions.syncChunk", { sessionId, transfer: response.transfer, offset }, machine);
      if (!data) throw new Error("Session transfer ended early");
      pieces.push(data);
      offset += data.length;
    }
    return JSON.parse(pieces.join("")) as SessionSync;
  };
  const apply = (base: HostSession | undefined, sync: SessionSync) =>
    applySessionSync(base as unknown as ProtocolSession | undefined, sync) as unknown as HostSession;
  try {
    return apply(known, await read(known?.revision));
  } catch (error) {
    if (!known || error instanceof Unauthorized) throw error;
    return apply(undefined, await read());
  }
}

export type Receipt = { commandId: string; sessionId: string; revision: number };

export function command(machine: string, input: Record<string, unknown>) {
  return rpc<Receipt>("commands.dispatch", { ...input, commandId: crypto.randomUUID() }, machine);
}

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
// Multiple of 4, so each piece is valid base64 on its own.
const CHUNK_CHARS = 4 * Math.floor((512 * 1024) / 3);

const base64 = (blob: Blob, name: string) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error(`Cannot read ${name}`));
    reader.readAsDataURL(blob);
  });

/** Uploads to the host's attachment store in chunks, as the desktop does. */
export async function uploadAttachment(machine: string, file: Blob, name: string, mimeType = file.type || "application/octet-stream"): Promise<Attachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${name} is too large (20 MB maximum)`);
  const data = await base64(file, name);
  const id = crypto.randomUUID();
  let offset = 0;
  if (!data.length) await rpc("attachments.upload", { id, offset: 0, size: file.size, data: "" }, machine);
  for (let index = 0; index < data.length; index += CHUNK_CHARS)
    offset = (
      await rpc<{ offset: number }>("attachments.upload", { id, offset, size: file.size, data: data.slice(index, index + CHUNK_CHARS) }, machine)
    ).offset;
  if (offset !== file.size) throw new Error(`Could not finish uploading ${name}`);
  const kind = mimeType.startsWith("image/") ? "image" : mimeType.startsWith("audio/") ? "audio" : "file";
  return { id, name, mimeType, kind, size: file.size };
}

/** An image sent in a session's messages, read in the chunks the host serves. */
export async function readAttachment(machine: string, sessionId: string, attachment: Attachment): Promise<Blob> {
  const pieces: Uint8Array[] = [];
  let offset = 0;
  while (offset < attachment.size) {
    const chunk = await rpc<{ data: string; offset: number }>("attachments.read", { sessionId, id: attachment.id, offset }, machine);
    if (!(chunk.offset > offset)) throw new Error(`Could not read ${attachment.name}`);
    pieces.push(Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0)));
    offset = chunk.offset;
  }
  return new Blob(pieces as BlobPart[], { type: attachment.mimeType });
}
