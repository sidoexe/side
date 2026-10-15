import { createPrivateKey, sign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { connect } from "node:http2";
import { dirname, isAbsolute, join } from "node:path";

/**
 * Apple Push for the native iPhone app. The host signs with the APNs key
 * from the developer account that signed the app: `apns.json`
 * (`{ "keyId": "…", "teamId": "…" }`) and `apns.p8` beside `push.json`.
 */

export type ApnsConfig = { keyId: string; teamId: string; key: string };
export type ApnsEnvironment = "development" | "production";
export type ApnsDevice = { token: string; environment: ApnsEnvironment; bundleId: string; createdAt: number };
export type ApnsNotification = {
  title: string;
  body: string;
  /** Replaces an earlier notification with the same id. */
  collapseId: string;
  threadId: string;
  data: Record<string, string>;
};
/** Sends one notification; resolves with the APNs status and reason. */
export type ApnsSend = (
  device: ApnsDevice,
  authorization: string,
  notification: ApnsNotification,
) => Promise<{ status: number; reason?: string }>;

/** Reads the key beside `pushFile`; absent until the user adds one. A
 * broken key is reported and leaves Apple Push off, not the host down. */
export function loadApnsConfig(pushFile: string): ApnsConfig | undefined {
  try {
    return readApnsConfig(pushFile);
  } catch (error) {
    console.error(`APNs is off: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

function readApnsConfig(pushFile: string): ApnsConfig | undefined {
  const directory = dirname(pushFile);
  const file = join(directory, "apns.json");
  if (!existsSync(file)) return undefined;
  const value = JSON.parse(readFileSync(file, "utf8")) as { keyId?: string; teamId?: string; keyFile?: string };
  if (!value.keyId || !value.teamId) throw new Error(`${file} needs keyId and teamId`);
  const keyFile = value.keyFile ? (isAbsolute(value.keyFile) ? value.keyFile : join(directory, value.keyFile)) : join(directory, "apns.p8");
  const key = readFileSync(keyFile, "utf8");
  createPrivateKey(key);
  return { keyId: value.keyId, teamId: value.teamId, key };
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** The provider token APNs asks for: ES256, valid up to an hour. */
export function apnsToken(config: ApnsConfig, now = Date.now()): string {
  const header = b64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = b64url(JSON.stringify({ iss: config.teamId, iat: Math.floor(now / 1000) }));
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: createPrivateKey(config.key),
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${claims}.${b64url(signature)}`;
}

/** APNs speaks HTTP/2 only, which `fetch` does not. */
export const sendApns: ApnsSend = (device, authorization, notification) =>
  new Promise((resolve, reject) => {
    const origin = device.environment === "production" ? "https://api.push.apple.com" : "https://api.sandbox.push.apple.com";
    const session = connect(origin);
    session.on("error", reject);
    const request = session.request({
      ":method": "POST",
      ":path": `/3/device/${device.token}`,
      authorization: `bearer ${authorization}`,
      "apns-topic": device.bundleId,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": notification.collapseId.slice(0, 64),
    });
    request.setTimeout(10_000, () => request.close());
    let status = 0;
    let body = "";
    request.on("response", (headers) => (status = Number(headers[":status"])));
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      session.close();
      let reason: string | undefined;
      try {
        reason = (JSON.parse(body) as { reason?: string }).reason;
      } catch {
        /* an empty body on success */
      }
      resolve({ status, reason });
    });
    request.on("error", (error) => {
      session.close();
      reject(error);
    });
    request.end(
      JSON.stringify({
        aps: { alert: { title: notification.title, body: notification.body }, sound: "default", "thread-id": notification.threadId },
        ...notification.data,
      }),
    );
  });

/** Tokens APNs says will never deliver again. */
export function apnsTokenGone(result: { status: number; reason?: string }): boolean {
  return result.status === 410 || (result.status === 400 && (result.reason === "BadDeviceToken" || result.reason === "DeviceTokenNotForTopic"));
}
