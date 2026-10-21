import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostMachines, machineAddress } from "./machines";

const TOKEN = "a".repeat(43);

/** A machine's host answering at `url`, as fetch sees it. */
function peer(environmentId = "peer-env", status = 200) {
  const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, body, auth: new Headers(init.headers).get("authorization") });
    if (status !== 200) return new Response(JSON.stringify({ error: "nope" }), { status });
    const result =
      body.method === "environment.describe"
        ? { protocolVersion: 1, environmentId, name: "Work Mac", providers: [], capabilities: [] }
        : { echoed: body.method };
    return new Response(JSON.stringify({ result }));
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const store = (fetcher: typeof fetch) => {
  const path = join(mkdtempSync(join(tmpdir(), "side-machines-")), "machines.json");
  return { path, machines: new HostMachines(path, "this-env", fetcher) };
};

describe("machineAddress", () => {
  it("reads an address with a credential, or a pairing link", () => {
    expect(machineAddress("work.tail.ts.net/web/", TOKEN)).toEqual({ url: "https://work.tail.ts.net", token: TOKEN });
    expect(machineAddress(`side://pair?host=${encodeURIComponent("https://work.tail.ts.net")}&token=${TOKEN}`)).toEqual({
      url: "https://work.tail.ts.net",
      token: TOKEN,
    });
    expect(machineAddress("http://127.0.0.1:3775", TOKEN).url).toBe("http://127.0.0.1:3775");
  });

  it("refuses plain HTTP to another computer and malformed credentials", () => {
    expect(() => machineAddress("http://work.tail.ts.net", TOKEN)).toThrow(/HTTPS/);
    expect(() => machineAddress("https://work.tail.ts.net", "short")).toThrow(/credential/);
  });
});

describe("HostMachines", () => {
  it("checks a machine before keeping it, and never lists its credential", async () => {
    const { fetcher, calls } = peer();
    const { path, machines } = store(fetcher);
    const added = await machines.add("https://work.tail.ts.net", TOKEN);
    expect(added).toMatchObject({ name: "Work Mac", url: "https://work.tail.ts.net", environmentId: "peer-env" });
    expect(calls[0]).toMatchObject({ url: "https://work.tail.ts.net/rpc", auth: `Bearer ${TOKEN}` });
    expect(machines.list()).toEqual([added]);
    expect(JSON.stringify(machines.list())).not.toContain(TOKEN);
    expect(readFileSync(path, "utf8")).toContain(TOKEN);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses this machine itself, and a credential the machine rejects", async () => {
    await expect(store(peer("this-env").fetcher).machines.add("https://me.ts.net", TOKEN)).rejects.toThrow(/this machine/);
    await expect(store(peer("x", 401).fetcher).machines.add("https://work.ts.net", TOKEN)).rejects.toThrow(/refused/);
  });

  it("adding the same machine again replaces it rather than listing it twice", async () => {
    const { machines } = store(peer().fetcher);
    await machines.add("https://work.tail.ts.net", TOKEN);
    await machines.add("https://work-renamed.tail.ts.net", TOKEN);
    expect(machines.list().map((m) => m.url)).toEqual(["https://work-renamed.tail.ts.net"]);
  });

  it("relays a call with the kept credential, and hides the machine's 401 from the page", async () => {
    const ok = peer();
    const { machines } = store(ok.fetcher);
    const { id } = await machines.add("https://work.tail.ts.net", TOKEN);
    const reply = await machines.relay(id, { method: "projects.list", version: 1, environmentId: "peer-env", params: {} });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.text)).toEqual({ result: { echoed: "projects.list" } });
    expect(ok.calls.at(-1)?.auth).toBe(`Bearer ${TOKEN}`);
    expect((await machines.relay("00000000-0000-0000-0000-000000000000", {})).status).toBe(404);

    const revoked = new HostMachines(join(mkdtempSync(join(tmpdir(), "m-")), "m.json"), "this-env", peer("x", 401).fetcher);
    // Stored by hand: adding it would have been refused.
    (revoked as unknown as { write: (m: unknown[]) => void }).write([
      { id, name: "Work Mac", url: "https://work.ts.net", environmentId: "x", token: TOKEN },
    ]);
    expect((await revoked.relay(id, {})).status).toBe(502);
  });

  it("renames a machine, since two Macs often share a host name", async () => {
    const { machines } = store(peer().fetcher);
    const { id } = await machines.add("https://work.tail.ts.net", TOKEN);
    expect(machines.rename(id, "  Work  ")[0].name).toBe("Work");
    expect(() => machines.rename(id, " ")).toThrow(/name/);
  });

  it("removes a machine", async () => {
    const { machines } = store(peer().fetcher);
    const { id } = await machines.add("https://work.tail.ts.net", TOKEN);
    expect(machines.remove(id)).toEqual([]);
  });
});
