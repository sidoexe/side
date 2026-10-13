import { isRemoteProjectPath } from "../../projects/model/recents";
import { parseRemotePath, remotePath } from "./remoteProjects";

/**
 * An agent on a host names folders as that machine sees them; the desktop
 * runs its app CLI calls on `remote://` paths. These map the folder fields
 * of a call in, and every path of its answer back out.
 */

const PATH_FIELDS = new Set(["cwd", "worktreeCwd", "project", "path"]);
const ABSOLUTE = /^(\/|[A-Za-z]:[\\/])/;

export function callToDesktopPaths(
  input: Record<string, unknown>,
  environmentId: string,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      PATH_FIELDS.has(key) && typeof value === "string" && ABSOLUTE.test(value) && !isRemoteProjectPath(value)
        ? remotePath(environmentId, value)
        : value,
    ]),
  );
}

export function answerToHostPaths(value: unknown, environmentId: string): unknown {
  if (typeof value === "string") {
    const parsed = parseRemotePath(value);
    return parsed?.environmentId === environmentId ? parsed.hostPath : value;
  }
  if (Array.isArray(value)) return value.map((entry) => answerToHostPaths(entry, environmentId));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, answerToHostPaths(entry, environmentId)]),
    );
  return value;
}
