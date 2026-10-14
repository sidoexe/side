import {
  createECDH,
  createCipheriv,
  createPrivateKey,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { HostStore } from "./store";
import { sessionDisplayTitle } from "../src/features/sessions/model/session";

/**
 * Web Push for the browser app: the host keeps a VAPID key and the browsers
 * subscribed to it, watches its sessions, and tells them when one needs an
 * answer or finishes. Payloads are encrypted as RFC 8291 (aes128gcm) asks.
 */

export type PushSubscriptionJSON = { endpoint: string; keys: { p256dh: string; auth: string } };
type PushState = {
  vapid: { publicKey: string; privateKey: string };
  subscriptions: (PushSubscriptionJSON & { createdAt: number })[];
};
export type PushMessage = { title: string; body: string; url: string; tag: string };

const b64url = (bytes: Buffer) => bytes.toString("base64url");

/** The encrypted body and headers a push service accepts for `payload`. */
export function encryptPayload(subscription: PushSubscriptionJSON, payload: Buffer) {
  const uaPublic = Buffer.from(subscription.keys.p256dh, "base64url");
  const authSecret = Buffer.from(subscription.keys.auth, "base64url");
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error("Invalid push subscription keys");
  const ecdh = createECDH("prime256v1");
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = randomBytes(16);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // One record: the payload, then the last-record delimiter.
  const encrypted = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, encrypted]);
}

export class HostPush {
  private state: PushState;
  private seen = new Map<string, { running: boolean; needsInput: boolean }>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly file: string,
    private readonly send: typeof fetch = fetch,
  ) {
    this.state = this.load();
  }

  private load(): PushState {
    if (existsSync(this.file)) {
      try {
        const value = JSON.parse(readFileSync(this.file, "utf8")) as PushState;
        if (value.vapid?.publicKey && value.vapid.privateKey && Array.isArray(value.subscriptions)) return value;
      } catch {
        /* a damaged file starts over with a new key */
      }
    }
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = publicKey.export({ format: "jwk" });
    const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]);
    const state: PushState = {
      vapid: { publicKey: b64url(raw), privateKey: privateKey.export({ format: "pem", type: "pkcs8" }).toString() },
      subscriptions: [],
    };
    this.write(state);
    return state;
  }

  private write(state = this.state) {
    writeFileSync(this.file, JSON.stringify(state, null, 2), { mode: 0o600 });
  }

  publicKey(): string {
    return this.state.vapid.publicKey;
  }

  subscribe(input: unknown): { subscribed: true } {
    const value = input as PushSubscriptionJSON | undefined;
    let endpoint: URL;
    try {
      endpoint = new URL(String(value?.endpoint ?? ""));
    } catch {
      throw new Error("Invalid push subscription");
    }
    if (endpoint.protocol !== "https:" || typeof value?.keys?.p256dh !== "string" || typeof value.keys.auth !== "string")
      throw new Error("Invalid push subscription");
    this.state.subscriptions = [
      ...this.state.subscriptions.filter((entry) => entry.endpoint !== value.endpoint),
      { endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth }, createdAt: Date.now() },
    ].slice(-20);
    this.write();
    return { subscribed: true };
  }

  unsubscribe(endpoint: unknown): { subscribed: false } {
    this.state.subscriptions = this.state.subscriptions.filter((entry) => entry.endpoint !== endpoint);
    this.write();
    return { subscribed: false };
  }

  private vapidHeader(endpoint: string): string {
    const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
    const claims = b64url(
      Buffer.from(
        JSON.stringify({
          aud: new URL(endpoint).origin,
          exp: Math.floor(Date.now() / 1000) + 12 * 3600,
          sub: "https://github.com/sidoexe/side",
        }),
      ),
    );
    const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
      key: createPrivateKey(this.state.vapid.privateKey),
      dsaEncoding: "ieee-p1363",
    });
    return `vapid t=${header}.${claims}.${b64url(signature)}, k=${this.state.vapid.publicKey}`;
  }

  /** Sends to every subscribed browser; a subscription the service no longer
   * knows is forgotten. */
  async notify(message: PushMessage): Promise<void> {
    const payload = Buffer.from(JSON.stringify(message));
    const gone: string[] = [];
    await Promise.all(
      this.state.subscriptions.map(async (subscription) => {
        try {
          const response = await this.send(subscription.endpoint, {
            method: "POST",
            headers: {
              Authorization: this.vapidHeader(subscription.endpoint),
              "Content-Encoding": "aes128gcm",
              "Content-Type": "application/octet-stream",
              TTL: "86400",
              Urgency: "high",
              Topic: message.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32),
            },
            body: encryptPayload(subscription, payload),
            signal: AbortSignal.timeout(10_000),
          });
          if (response.status === 404 || response.status === 410) gone.push(subscription.endpoint);
        } catch {
          /* the next event tries again */
        }
      }),
    );
    if (gone.length) {
      this.state.subscriptions = this.state.subscriptions.filter((entry) => !gone.includes(entry.endpoint));
      this.write();
    }
  }

  /** Compares every session with the last look and announces a session that
   * starts waiting for an answer, or whose turn ends. The first look only
   * records what is there. */
  check(store: HostStore): PushMessage[] {
    const first = this.seen.size === 0;
    const messages: PushMessage[] = [];
    const next = new Map<string, { running: boolean; needsInput: boolean }>();
    for (const project of store.projects()) {
      for (const session of store.summaries(project.id)) {
        const now = { running: session.status === "running", needsInput: !!session.needsInput };
        next.set(session.id, now);
        const before = this.seen.get(session.id);
        if (first || !before || session.archived) continue;
        const title = sessionDisplayTitle(session.title, session.harness) || "Session";
        const url = `/web/#/s/${encodeURIComponent(project.id)}/${encodeURIComponent(session.id)}`;
        if (now.needsInput && !before.needsInput)
          messages.push({ title: `${project.name} · needs you`, body: title, url, tag: `input-${session.id}` });
        else if (before.running && !now.running && !now.needsInput)
          messages.push({ title: `${project.name} · done`, body: title, url, tag: `done-${session.id}` });
      }
    }
    // Keep sessions seen before, so a project that is briefly missing does
    // not count as new when it returns.
    this.seen = new Map([...this.seen, ...next]);
    if (first && !next.size) this.seen.set("", { running: false, needsInput: false });
    return messages;
  }

  watch(store: HostStore, every = 2000) {
    this.timer = setInterval(() => {
      if (!this.state.subscriptions.length) {
        this.seen.clear();
        return;
      }
      for (const message of this.check(store)) void this.notify(message);
    }, every);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
  }
}
