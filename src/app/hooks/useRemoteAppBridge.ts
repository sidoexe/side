import { useEffect, type RefObject } from "react";
import {
  knownRemoteMachine,
  remoteRequest,
  remoteSessionFor,
} from "../../features/connections/model/connections";
import { machineCapabilities } from "../../features/connections/model/homeCapability";
import {
  answerToHostPaths,
  callToDesktopPaths,
} from "../../features/connections/model/remoteAppCalls";
import { parseRemotePath } from "../../features/connections/model/remoteProjects";
import type { RemoteMachine } from "../../features/connections/model/protocol";
import type { Session } from "../../features/sessions/model/session";

/** One app CLI call, as the native control socket delivers it. */
export type ControlRequest = {
  id: string;
  namespace: string;
  sessionId: string;
  requestId: string;
  action: string;
  input: Record<string, unknown>;
};

type HostCall = Omit<ControlRequest, "namespace">;

const POLL_MS = 700;

type RelayDeps = {
  machineFor: (environmentId: string) => RemoteMachine | undefined;
  hostSessionFor: (shellId: string) => string | undefined;
  capabilities: (machine: RemoteMachine) => Promise<string[]>;
  request: <T>(machineId: string, method: string, params: unknown) => Promise<T>;
};

const defaultDeps: RelayDeps = {
  machineFor: knownRemoteMachine,
  hostSessionFor: remoteSessionFor,
  capabilities: machineCapabilities,
  request: remoteRequest,
};

/** Takes the app CLI calls waiting on the host sessions running here, runs
 * each like a local call, and sends the answers back. */
export async function relayAppCalls(
  sessions: readonly Session[],
  run: (payload: ControlRequest) => Promise<unknown>,
  deps: RelayDeps = defaultDeps,
): Promise<void> {
  const busy = sessions.filter((session) => session.busy && parseRemotePath(session.cwd));
  await Promise.all(busy.map(async (session) => {
    const environmentId = parseRemotePath(session.cwd)!.environmentId;
    const machine = deps.machineFor(environmentId);
    const hostId = deps.hostSessionFor(session.id);
    if (!machine || !hostId) return;
    const capabilities = await deps.capabilities(machine).catch((): string[] => []);
    if (!capabilities.includes("app")) return;
    const calls = await deps.request<HostCall[]>(machine.id, "app.take", { sessionId: hostId });
    for (const call of calls) {
      const response = await run({
        ...call,
        namespace: "app",
        sessionId: session.id,
        input: callToDesktopPaths(call.input, environmentId),
      }).then(
        (result) => ({ ok: true, result: answerToHostPaths(result, environmentId) }),
        (error: unknown) => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      await deps.request(machine.id, "app.reply", { id: call.id, response });
    }
  }));
}

/**
 * Agents a host runs call the app CLI through that host, which holds each
 * call until a desktop showing the session takes it. While a host session's
 * turn runs here, this relays its calls (see `relayAppCalls`).
 */
export function useRemoteAppBridge(
  sessionsRef: RefObject<Session[]>,
  handler: RefObject<((payload: ControlRequest) => Promise<unknown>) | undefined>,
): void {
  useEffect(() => {
    let polling = false;
    const pass = () => {
      const run = handler.current;
      if (polling || !run) return;
      polling = true;
      // A failed pass retries next tick; a call nobody answers times out on the host.
      void relayAppCalls(sessionsRef.current, run)
        .catch(() => undefined)
        .finally(() => {
          polling = false;
        });
    };
    const timer = window.setInterval(pass, POLL_MS);
    return () => window.clearInterval(timer);
  }, [sessionsRef, handler]);
}
