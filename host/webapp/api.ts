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

let environmentId = "";

export async function rpc<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  // Every call names the host it expects; learn it first.
  if (!environmentId && method !== "environment.describe") await describe();
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

export async function describe(): Promise<HostDescriptor> {
  const host = await rpc<HostDescriptor>("environment.describe", {
    supportedProviders: ["codex", "claude", "cursor", "grok", "opencode", "pi", "omp", "fx", "hermes", "antigravity", "devin"],
  });
  if (host.protocolVersion !== HOST_PROTOCOL_VERSION) throw new Error("This machine is running an incompatible sIDE Host");
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
  environmentId = "";
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

export function command(input: Record<string, unknown>) {
  return rpc<Receipt>("commands.dispatch", { ...input, commandId: crypto.randomUUID() });
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
export async function uploadAttachment(file: Blob, name: string, mimeType = file.type || "application/octet-stream"): Promise<Attachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${name} is too large (20 MB maximum)`);
  const data = await base64(file, name);
  const id = crypto.randomUUID();
  let offset = 0;
  if (!data.length) await rpc("attachments.upload", { id, offset: 0, size: file.size, data: "" });
  for (let index = 0; index < data.length; index += CHUNK_CHARS)
    offset = (
      await rpc<{ offset: number }>("attachments.upload", { id, offset, size: file.size, data: data.slice(index, index + CHUNK_CHARS) })
    ).offset;
  if (offset !== file.size) throw new Error(`Could not finish uploading ${name}`);
  const kind = mimeType.startsWith("image/") ? "image" : mimeType.startsWith("audio/") ? "audio" : "file";
  return { id, name, mimeType, kind, size: file.size };
}

/** An image sent in a session's messages, read in the chunks the host serves. */
export async function readAttachment(sessionId: string, attachment: Attachment): Promise<Blob> {
  const pieces: Uint8Array[] = [];
  let offset = 0;
  while (offset < attachment.size) {
    const chunk = await rpc<{ data: string; offset: number }>("attachments.read", { sessionId, id: attachment.id, offset });
    if (!(chunk.offset > offset)) throw new Error(`Could not read ${attachment.name}`);
    pieces.push(Uint8Array.from(atob(chunk.data), (c) => c.charCodeAt(0)));
    offset = chunk.offset;
  }
  return new Blob(pieces as BlobPart[], { type: attachment.mimeType });
}
