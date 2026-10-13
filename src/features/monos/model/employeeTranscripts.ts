import { invoke } from "@tauri-apps/api/core";
import { remoteRequest } from "../../connections/model/connections";
import type { RemoteMachine } from "../../connections/model/protocol";
import { employeeHome } from "./employeeStorage";

/**
 * Employees' conversations follow their files (see `employeeStorage.ts`):
 * on the home machine's host when it keeps employees, so every desktop opens
 * the same chat, and in this computer's session store otherwise. The calls
 * take and return what the native `mono_session_*` commands do.
 */

type Page = { blocks: unknown[]; before: number | null; hasNewer: boolean };
type Record = { [key: string]: unknown; blocks: unknown[]; monoTranscript?: { before: number | null } };

const IMPORTED_KEY = "side.employeeChatsImported.v1";
/** Well under the host's request limit, after JSON escaping. */
const CHUNK_BYTES = 4 * 1024 * 1024;

function imported(): { [key: string]: true } {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(IMPORTED_KEY) ?? "{}");
    return value && typeof value === "object" ? (value as { [key: string]: true }) : {};
  } catch {
    return {};
  }
}

function markImported(key: string): void {
  try {
    localStorage.setItem(IMPORTED_KEY, JSON.stringify({ ...imported(), [key]: true }));
  } catch {
    /* asked again next time; an import never replaces the host's chat */
  }
}

/** Every saved block of a local chat, oldest first. */
async function localBlocks(sessionId: string, record: Record): Promise<unknown[]> {
  let blocks = record.blocks;
  let before = record.monoTranscript?.before ?? null;
  while (before != null) {
    const page = await invoke<Page>("mono_session_page", {
      sessionId,
      before,
      beforeBlockId: null,
      aroundBlockId: null,
    });
    blocks = [...page.blocks, ...blocks];
    before = page.before;
  }
  return blocks;
}

function chunks(blocks: unknown[]): unknown[][] {
  const out: unknown[][] = [];
  let current: unknown[] = [];
  let size = 0;
  for (const block of blocks) {
    const bytes = JSON.stringify(block).length;
    if (current.length && size + bytes > CHUNK_BYTES) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(block);
    size += bytes;
  }
  if (current.length) out.push(current);
  return out;
}

const importing = new Map<string, Promise<void>>();

/** Copies a chat this computer kept to the host, once, when the host has none. */
function importOnce(home: RemoteMachine, sessionId: string): Promise<void> {
  const key = `${home.environmentId}:${sessionId}`;
  if (imported()[key]) return Promise.resolve();
  let pending = importing.get(key);
  if (!pending) {
    pending = (async () => {
      const onHost = await remoteRequest<Record | null>(home.id, "employees.sessionGet", { sessionId });
      const local = onHost ? null : await invoke<Record | null>("mono_session_get", { sessionId });
      if (local) {
        const {
          blocks: _blocks,
          monoTranscript: _transcript,
          createdAt: _created,
          updatedAt: _updated,
          ...header
        } = local;
        let last: string | null = null;
        const parts = chunks(await localBlocks(sessionId, local));
        for (const [index, blocks] of (parts.length ? parts : [[]]).entries()) {
          await remoteRequest(home.id, "employees.sessionUpsert", {
            session: { ...header, blocks },
            blocksChanged: true,
            appendOnly: index > 0,
            baseLastBlockId: last,
          });
          const tail = blocks[blocks.length - 1] as { id?: unknown } | undefined;
          if (typeof tail?.id === "string") last = tail.id;
        }
      }
      markImported(key);
    })().finally(() => importing.delete(key));
    importing.set(key, pending);
  }
  return pending;
}

async function onHome<T>(
  sessionId: string,
  local: () => Promise<T>,
  remote: (home: RemoteMachine) => Promise<T>,
): Promise<T> {
  const home = await employeeHome();
  if (!home) return local();
  await importOnce(home, sessionId);
  return remote(home);
}

export function getEmployeeTranscript<T>(sessionId: string): Promise<T | null> {
  return onHome(
    sessionId,
    () => invoke<T | null>("mono_session_get", { sessionId }),
    (home) => remoteRequest<T | null>(home.id, "employees.sessionGet", { sessionId }),
  );
}

export function getEmployeeTranscriptPage<T>(args: {
  sessionId: string;
  before: number | null;
  beforeBlockId: string | null;
  aroundBlockId: string | null;
}): Promise<T> {
  return onHome(
    args.sessionId,
    () => invoke<T>("mono_session_page", args),
    (home) => remoteRequest<T>(home.id, "employees.sessionPage", args),
  );
}

export function findEmployeeTranscript(sessionId: string, query: string): Promise<string[]> {
  return onHome(
    sessionId,
    () => invoke<string[]>("mono_session_find", { sessionId, query }),
    (home) => remoteRequest<string[]>(home.id, "employees.sessionFind", { sessionId, query }),
  );
}

/** `baseLastBlockId` is the last block this writer saved before; the host
 * merges instead of replacing when another desktop wrote after it. */
export function saveEmployeeTranscript<T>(args: {
  session: { id: string } & { [key: string]: unknown };
  afterBlockId: string | null;
  fromBlockId: string | null;
  blocksChanged: boolean;
  appendOnly: boolean;
  baseLastBlockId: string | null;
}): Promise<T> {
  return onHome(
    args.session.id,
    () => invoke<T>("mono_session_upsert", args),
    (home) => remoteRequest<T>(home.id, "employees.sessionUpsert", args),
  );
}

/** Removes the host's copy; this computer's own is deleted as any session. */
export async function deleteEmployeeTranscript(sessionId: string): Promise<void> {
  const home = await employeeHome();
  if (!home) return;
  markImported(`${home.environmentId}:${sessionId}`);
  await remoteRequest(home.id, "employees.sessionDelete", { sessionId });
}
