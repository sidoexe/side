import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";

/**
 * The sIDE app CLI for sessions this host runs. Locally, a provider reaches
 * the desktop's own control socket; here it runs on another machine, so its
 * `app` calls come to the host, wait in a queue, and the desktop showing the
 * session takes them, runs them as it would a local call, and replies.
 *
 * Every host session gets a credential before its provider first starts,
 * since a provider process can outlive one turn. A call is only accepted
 * while that session's turn runs, in a thread the user enabled with
 * /operator, which the host remembers across restarts.
 */

const WAIT_MS = 35_000;
const MAX_PENDING = 24;
/** How long a desktop that took a call has to answer before another may. */
const LEASE_MS = 40_000;

export const APP_TURN_INACTIVE =
  "sIDE app access is inactive. Use /operator once in this thread to enable it, then call the CLI during an active agent turn. Retrying this request now will not enable access.";

export type AppCall = {
  id: string;
  sessionId: string;
  requestId: string;
  action: string;
  input: Record<string, unknown>;
};

type Pending = AppCall & {
  takenBy?: string;
  takenAt?: number;
  resolve: (response: unknown) => void;
};

export class HostAppBridge {
  private tokens = new Map<string, string>();
  private pending = new Map<string, Pending>();
  private enabled: Set<string>;

  constructor(
    private readonly accessPath: string,
    private readonly turnRunning: (sessionId: string) => boolean,
    private readonly now: () => number = Date.now,
  ) {
    try {
      const value: unknown = JSON.parse(readFileSync(accessPath, "utf8"));
      this.enabled = new Set(Array.isArray(value) ? value.filter((id) => typeof id === "string") : []);
    } catch {
      this.enabled = new Set();
    }
  }

  /** The credential a session's provider process is started with. */
  token(sessionId: string): string {
    let token = this.tokens.get(sessionId);
    if (!token) {
      token = randomBytes(32).toString("base64url");
      this.tokens.set(sessionId, token);
    }
    return token;
  }

  /** /operator was used in this thread: later turns keep app access. */
  enable(sessionId: string): void {
    if (this.enabled.has(sessionId)) return;
    this.enabled.add(sessionId);
    const temp = `${this.accessPath}.tmp`;
    writeFileSync(temp, JSON.stringify([...this.enabled]), { mode: 0o600 });
    renameSync(temp, this.accessPath);
  }

  enabledFor(sessionId: string): boolean {
    return this.enabled.has(sessionId);
  }

  private sessionFor(token: unknown): string | undefined {
    if (typeof token !== "string" || !token) return undefined;
    const given = Buffer.from(token);
    for (const [sessionId, expected] of this.tokens) {
      const known = Buffer.from(expected);
      if (known.length === given.length && timingSafeEqual(known, given)) return sessionId;
    }
    return undefined;
  }

  /** One CLI call: answers once the desktop replies, or after 35 s. */
  request(body: unknown): Promise<unknown> {
    const value = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const sessionId = this.sessionFor(value.token);
    if (!sessionId) return Promise.resolve({ ok: false, error: "No sIDE session credential. Start the agent from sIDE." });
    if (!this.enabled.has(sessionId) || !this.turnRunning(sessionId))
      return Promise.resolve({ ok: false, error: APP_TURN_INACTIVE, retryable: false });
    const input = value.input;
    const requestId = value.requestId;
    if (
      !input || typeof input !== "object" || Array.isArray(input) ||
      typeof requestId !== "string" || !requestId || requestId.length > 128 ||
      typeof value.action !== "string" || !value.action || value.action.length > 64
    )
      return Promise.resolve({ ok: false, error: "Invalid input or request ID" });
    if (this.pending.size >= MAX_PENDING)
      return Promise.resolve({ ok: false, error: "Too many pending control requests" });
    return new Promise((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: "Control request timed out. Retry with the same request ID." });
      }, WAIT_MS);
      timer.unref?.();
      this.pending.set(id, {
        id,
        sessionId,
        requestId,
        action: value.action as string,
        input: input as Record<string, unknown>,
        resolve: (response) => {
          clearTimeout(timer);
          this.pending.delete(id);
          resolve(response);
        },
      });
    });
  }

  /** Calls waiting on a session, leased to the desktop that takes them so
   * two desktops showing the same session never both run one. */
  take(sessionId: unknown, device: string | undefined): AppCall[] {
    const at = this.now();
    const taken: AppCall[] = [];
    for (const call of this.pending.values()) {
      if (call.sessionId !== sessionId) continue;
      if (call.takenBy && call.takenBy !== device && at - (call.takenAt ?? 0) < LEASE_MS) continue;
      call.takenBy = device ?? "";
      call.takenAt = at;
      const { resolve: _, takenBy: __, takenAt: ___, ...open } = call;
      taken.push(open);
    }
    return taken;
  }

  reply(id: unknown, response: unknown): boolean {
    const call = typeof id === "string" ? this.pending.get(id) : undefined;
    if (!call) return false;
    const value = response && typeof response === "object" ? response : { ok: false, error: "Invalid reply" };
    call.resolve(value);
    return true;
  }

  /** A deleted session's credential stops working. */
  forget(sessionId: string): void {
    this.tokens.delete(sessionId);
    for (const call of [...this.pending.values()])
      if (call.sessionId === sessionId) call.resolve({ ok: false, error: "The session was deleted." });
  }
}
