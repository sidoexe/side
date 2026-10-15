import { afterEach, describe, expect, it } from "vitest";
import { createDecipheriv, createECDH, generateKeyPairSync, hkdfSync, randomBytes, verify, createPublicKey } from "node:crypto";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encryptPayload, HostPush } from "./push";
import { loadApnsConfig, type ApnsDevice, type ApnsNotification } from "./apns";
import type { HostStore } from "./store";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A browser's side of a push subscription, able to read what it receives. */
function browser() {
  const ecdh = createECDH("prime256v1");
  const publicKey = ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    subscription: {
      endpoint: "https://push.example.com/send/abc",
      keys: { p256dh: publicKey.toString("base64url"), auth: auth.toString("base64url") },
    },
    decrypt(body: Buffer): string {
      const salt = body.subarray(0, 16);
      const idlen = body.readUInt8(20);
      const asPublic = body.subarray(21, 21 + idlen);
      const shared = ecdh.computeSecret(asPublic);
      const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), publicKey, asPublic]);
      const ikm = Buffer.from(hkdfSync("sha256", shared, auth, keyInfo, 32));
      const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
      const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
      const record = body.subarray(21 + idlen);
      const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
      decipher.setAuthTag(record.subarray(record.length - 16));
      const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
      expect(plain[plain.length - 1]).toBe(2);
      return plain.subarray(0, -1).toString();
    },
  };
}

function setup(send: typeof fetch = (async () => new Response(null, { status: 201 })) as typeof fetch) {
  const dir = mkdtempSync(join(tmpdir(), "side-push-"));
  dirs.push(dir);
  return { dir, push: new HostPush(join(dir, "push.json"), send) };
}

describe("web push", () => {
  it("encrypts a payload only its subscriber can read", () => {
    const b = browser();
    expect(b.decrypt(encryptPayload(b.subscription, Buffer.from("hello")))).toBe("hello");
  });

  it("keeps one VAPID key in a private file", () => {
    const { dir, push } = setup();
    const key = push.publicKey();
    expect(Buffer.from(key, "base64url")).toHaveLength(65);
    expect(new HostPush(join(dir, "push.json")).publicKey()).toBe(key);
    expect(statSync(join(dir, "push.json")).mode & 0o777).toBe(0o600);
  });

  it("refuses a subscription that is not an HTTPS push endpoint", () => {
    const { push } = setup();
    expect(() => push.subscribe({ endpoint: "http://push.example.com/x", keys: { p256dh: "a", auth: "b" } })).toThrow();
    expect(() => push.subscribe({ endpoint: "nope" })).toThrow();
  });

  it("sends a signed, encrypted message and forgets a subscription that is gone", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let status = 201;
    const { push } = setup((async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status });
    }) as typeof fetch);
    const b = browser();
    push.subscribe(b.subscription);
    const message = { title: "app · done", body: "Fix the build", url: "/web/#/s/p/s", tag: "done-s" };
    await push.notify(message);
    expect(calls).toHaveLength(1);
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(JSON.parse(b.decrypt(calls[0].init.body as Buffer))).toEqual(message);
    // The VAPID token verifies against the public key the browser subscribed with.
    const [, token, key] = headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/)!;
    const [h, c, sig] = token.split(".");
    expect(JSON.parse(Buffer.from(c, "base64url").toString()).aud).toBe("https://push.example.com");
    const raw = Buffer.from(key, "base64url");
    const publicKey = createPublicKey({
      key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") },
      format: "jwk",
    });
    expect(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"))).toBe(true);
    status = 410;
    await push.notify(message);
    calls.length = 0;
    await push.notify(message);
    expect(calls).toHaveLength(0);
  });

  it("announces a session that starts waiting for an answer or finishes", () => {
    const { push } = setup();
    const sessions = new Map([["s1", { status: "running", needsInput: false }], ["s2", { status: "running", needsInput: false }]]);
    const store = {
      projects: () => [{ id: "p", name: "app", cwd: "/x" }],
      summaries: () =>
        [...sessions].map(([id, state]) => ({ id, projectId: "p", title: `claude · ${id}`, harness: "claude", updatedAt: 1, revision: 1, ...state })),
    } as unknown as HostStore;
    expect(push.check(store)).toEqual([]);
    sessions.set("s1", { status: "running", needsInput: true });
    sessions.set("s2", { status: "idle", needsInput: false });
    expect(push.check(store).map((m) => [m.title, m.body])).toEqual([
      ["app · needs you", "s1"],
      ["app · done", "s2"],
    ]);
    expect(push.check(store)).toEqual([]);
  });
});

describe("apple push", () => {
  const token = "ab".repeat(32);
  function apnsSetup(results: { status: number; reason?: string }[] = []) {
    const dir = mkdtempSync(join(tmpdir(), "side-apns-"));
    dirs.push(dir);
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    writeFileSync(join(dir, "apns.p8"), privateKey.export({ format: "pem", type: "pkcs8" }));
    writeFileSync(join(dir, "apns.json"), JSON.stringify({ keyId: "KEY123", teamId: "TEAM456" }));
    const file = join(dir, "push.json");
    const calls: { device: ApnsDevice; authorization: string; notification: ApnsNotification }[] = [];
    const push = new HostPush(file, (async () => new Response(null, { status: 201 })) as typeof fetch, {
      config: loadApnsConfig(file),
      send: async (device, authorization, notification) => {
        calls.push({ device, authorization, notification });
        return results.shift() ?? { status: 200 };
      },
    });
    return { dir, file, push, calls, publicKey };
  }

  it("is off until the host has a key, and a broken key does not stop the host", () => {
    const { push } = setup();
    expect(push.apnsEnabled()).toBe(false);
    const { dir, file } = apnsSetup();
    writeFileSync(join(dir, "apns.p8"), "not a key");
    expect(loadApnsConfig(file)).toBeUndefined();
  });

  it("refuses a registration that is not an APNs token", () => {
    const { push } = apnsSetup();
    expect(() => push.registerApns({ token: "nope", bundleId: "dev.sidoexe.side.mobile" })).toThrow();
    expect(() => push.registerApns({ token, bundleId: "bad id/" })).toThrow();
  });

  it("sends a signed notification that opens its session, and forgets a token Apple rejects", async () => {
    const { file, push, calls, publicKey } = apnsSetup([{ status: 200 }, { status: 410 }]);
    expect(push.apnsEnabled()).toBe(true);
    push.registerApns({ token, environment: "production", bundleId: "dev.sidoexe.side.mobile" });
    const message = {
      title: "app · needs you", body: "Fix the build", url: "/web/#/s/p/s", tag: "input-s", projectId: "p", sessionId: "s",
    };
    await push.notify(message);
    expect(calls).toHaveLength(1);
    expect(calls[0].device).toMatchObject({ token, environment: "production", bundleId: "dev.sidoexe.side.mobile" });
    expect(calls[0].notification).toEqual({
      title: "app · needs you", body: "Fix the build", collapseId: "input-s", threadId: "s", data: { projectId: "p", sessionId: "s" },
    });
    const [h, c, sig] = calls[0].authorization.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY123" });
    expect(JSON.parse(Buffer.from(c, "base64url").toString()).iss).toBe("TEAM456");
    expect(verify("sha256", Buffer.from(`${h}.${c}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url"))).toBe(true);
    await push.notify(message);
    // The provider token is reused rather than renewed per notification.
    expect(calls[1].authorization).toBe(calls[0].authorization);
    calls.length = 0;
    await push.notify(message);
    expect(calls).toHaveLength(0);
    expect(new HostPush(file).apnsEnabled()).toBe(true);
  });

  it("names the session a notification is about", () => {
    const { push } = setup();
    const sessions = new Map([["s1", { status: "running", needsInput: false }]]);
    const store = {
      projects: () => [{ id: "p", name: "app", cwd: "/x" }],
      summaries: () =>
        [...sessions].map(([id, state]) => ({ id, projectId: "p", title: `claude · ${id}`, harness: "claude", updatedAt: 1, revision: 1, ...state })),
    } as unknown as HostStore;
    push.check(store);
    sessions.set("s1", { status: "idle", needsInput: false });
    expect(push.check(store)).toMatchObject([{ projectId: "p", sessionId: "s1", tag: "done-s1" }]);
  });
});
