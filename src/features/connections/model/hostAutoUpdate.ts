import { invoke } from "@tauri-apps/api/core";
import { remoteRequest } from "./connections";
import { hostIsOlder } from "./hostVersion";
import {
  REMOTE_PROVIDERS,
  type HostDescriptor,
  type HostProject,
  type RemoteMachine,
  type SshSetup,
} from "./protocol";

/**
 * Brings an SSH machine's host up to this desktop's release by itself, the
 * way Update Host does, so new host features arrive with the app update.
 * Updating restarts the host, so it waits until no turn runs there; a host
 * that needs a password or passphrase is left to Settings → Connections.
 */
const POLL_MS = 500;
const JOB_TIMEOUT_MS = 10 * 60_000;

export type AutoUpdateResult = "current" | "busy" | "updated" | "skipped" | "failed";

export type AutoUpdateDeps = {
  request: <T>(machineId: string, method: string, params?: Record<string, unknown>) => Promise<T>;
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  sleep: (ms: number) => Promise<void>;
};

const defaults: AutoUpdateDeps = {
  request: (machineId, method, params) => remoteRequest(machineId, method, params),
  invoke: (command, args) => invoke(command, args),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Whether a turn runs in any of the host's projects. */
async function hostBusy(machine: RemoteMachine, deps: AutoUpdateDeps): Promise<boolean> {
  const projects = await deps.request<HostProject[]>(machine.id, "projects.list");
  for (const project of projects) {
    const sessions = await deps.request<{ status?: string }[]>(machine.id, "sessions.list", {
      projectId: project.id,
    });
    if (sessions.some((session) => session.status === "running")) return true;
  }
  return false;
}

export async function updateHostIfOlder(
  machine: RemoteMachine,
  appVersion: string,
  deps: AutoUpdateDeps = defaults,
): Promise<AutoUpdateResult> {
  if (!machine.ssh) return "skipped";
  const host = await deps.request<HostDescriptor>(machine.id, "environment.describe", {
    supportedProviders: REMOTE_PROVIDERS,
  });
  if (!hostIsOlder(host.version, appVersion)) return "current";
  if (await hostBusy(machine, deps)) return "busy";
  const jobId = await deps.invoke<string>("remote_ssh_reconnect", {
    machineId: machine.id,
    upgrade: true,
  });
  const started = Date.now();
  for (;;) {
    await deps.sleep(POLL_MS);
    const job = await deps.invoke<SshSetup>("remote_ssh_poll", { jobId });
    if (job.done) return job.error ? "failed" : "updated";
    if (job.prompt || Date.now() - started > JOB_TIMEOUT_MS) {
      await deps.invoke("remote_ssh_cancel", { jobId }).catch(() => undefined);
      return "skipped";
    }
  }
}
