import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { HOST_PROTOCOL_VERSION, REMOTE_PROVIDERS, type HostDescriptor } from "../src/features/connections/model/protocol";

/**
 * The other machines the browser app shows beside this one. Every machine
 * runs its own host and stays the only engine for its sessions; this host
 * keeps each one's address and device credential, so the page it serves can
 * reach them through `/web/machines/<id>/rpc` without ever holding a token.
 *
 * The credentials control those machines as their OS users: the file is
 * readable by this user only, as the desktop's connection store is.
 */

export type HostMachine = { id: string; name: string; url: string; environmentId: string };
type Stored = HostMachine & { token: string };

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_MACHINES = 20;
const RELAY_TIMEOUT_MS = 60_000;

/** An address as typed, or a pairing link: HTTPS, or HTTP to this computer
 * only, without the `/web` the browser app lives under. */
export function machineAddress(input: string, token = ""): { url: string; token: string } {
  let text = input.trim();
  if (text.startsWith("side://")) {
    const link = new URL(text.replace(/^side:/, "https:"));
    text = link.searchParams.get("host") ?? "";
    token = link.searchParams.get("token") ?? "";
  }
  token = token.trim();
  if (!TOKEN.test(token)) throw new Error("That is not a pairing link or a 43-character credential");
  if (!/^https?:\/\//.test(text)) text = `https://${text}`;
  const url = new URL(text);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    throw new Error("Use an HTTPS address, or HTTP to this computer");
  const path = url.pathname.replace(/\/+$/, "").replace(/\/web$/, "");
  return { url: `${url.origin}${path}`, token };
}

export class HostMachines {
  constructor(
    private readonly path: string,
    /** This host's own identity, so it is not added as another machine. */
    private readonly environmentId: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private read(): Stored[] {
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8")) as { machines?: Stored[] };
      return Array.isArray(value.machines) ? value.machines.filter((m) => ID.test(m.id) && TOKEN.test(m.token)) : [];
    } catch {
      return [];
    }
  }

  private write(machines: Stored[]) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify({ machines }, null, 2), { mode: 0o600 });
  }

  list(): HostMachine[] {
    return this.read().map(({ token: _token, ...machine }) => machine);
  }

  /** One RPC call to a machine's own host, as the desktop makes it. */
  private async call(url: string, token: string, input: Record<string, unknown>) {
    const response = await this.fetcher(`${url}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    return { status: response.status, text: await response.text() };
  }

  /** Checks the credential against the machine before keeping it. */
  async add(input: unknown, token?: unknown, name?: unknown): Promise<HostMachine> {
    if (typeof input !== "string") throw new Error("Provide the machine's address or pairing link");
    const address = machineAddress(input, typeof token === "string" ? token : "");
    const { status, text } = await this.call(address.url, address.token, {
      version: HOST_PROTOCOL_VERSION,
      environmentId: "",
      method: "environment.describe",
      params: { supportedProviders: REMOTE_PROVIDERS },
    });
    const reply = JSON.parse(text || "{}") as { result?: HostDescriptor; error?: string };
    if (status === 401) throw new Error("That machine refused the credential");
    if (status !== 200 || !reply.result) throw new Error(reply.error ?? `That machine answered HTTP ${status}`);
    const host = reply.result;
    if (host.protocolVersion !== HOST_PROTOCOL_VERSION) throw new Error("That machine runs an incompatible sIDE Host");
    if (host.environmentId === this.environmentId) throw new Error("That is this machine");
    const machines = this.read().filter((m) => m.environmentId !== host.environmentId);
    if (machines.length >= MAX_MACHINES) throw new Error("Too many machines");
    const machine: Stored = {
      id: randomUUID(),
      name: (typeof name === "string" && name.trim().slice(0, 80)) || host.name,
      url: address.url,
      environmentId: host.environmentId,
      token: address.token,
    };
    this.write([...machines, machine]);
    const { token: _token, ...shown } = machine;
    return shown;
  }

  /** The name it is shown under here; two Macs often share a host name. */
  rename(id: unknown, name: unknown): HostMachine[] {
    if (typeof name !== "string" || !name.trim()) throw new Error("Provide a name");
    this.write(this.read().map((m) => (m.id === id ? { ...m, name: name.trim().slice(0, 80) } : m)));
    return this.list();
  }

  remove(id: unknown): HostMachine[] {
    this.write(this.read().filter((m) => m.id !== id));
    return this.list();
  }

  /** Passes one browser RPC call on to a machine, unchanged, with its credential. */
  async relay(id: string, input: Record<string, unknown>) {
    const machine = this.read().find((m) => m.id === id);
    if (!machine) return { status: 404, text: JSON.stringify({ error: "Machine not found" }) };
    try {
      const reply = await this.call(machine.url, machine.token, input);
      // Its 401 is about this host's credential there, not the browser's
      // here: the page must not sign itself out of this host for it.
      if (reply.status === 401)
        return { status: 502, text: JSON.stringify({ error: `${machine.name} refused this host's credential; add it again` }) };
      return reply;
    } catch (error) {
      const message = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "is unreachable";
      return { status: 502, text: JSON.stringify({ error: `${machine.name} ${message}` }) };
    }
  }
}
