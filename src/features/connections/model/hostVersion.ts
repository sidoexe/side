/** Whether a host runs an older release than this desktop. A host that does
 * not say (before 0.20) is older. A development build of either side, with
 * no comparable version, is never called older. */
export function hostIsOlder(hostVersion: string | undefined, appVersion: string): boolean {
  const app = parse(appVersion);
  if (!app) return false;
  if (!hostVersion) return true;
  const host = parse(hostVersion);
  if (!host) return false;
  for (let index = 0; index < 3; index++)
    if (host[index] !== app[index]) return host[index] < app[index];
  return false;
}

function parse(version: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}
