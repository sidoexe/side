import { version } from "../package.json";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { hostCommitMessage } from "./commit-message";
import { hostname, homedir } from "node:os";
import { execFile, execFileSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { promisify } from "node:util";
import {
  HOST_PROTOCOL_VERSION,
  type HostModelCatalog,
  type RemoteProvider,
} from "../src/features/connections/model/protocol";
import { HostEngine } from "./engine";
import { writeAttachmentChunk, readAttachmentChunk } from "./attachments";
import type { LinkedWorkItem } from "../src/features/sessions/model/session";
import { parseGithubWorkItemUrl } from "../src/features/sessions/model/sessionWorkItem";
import { SyncTransfers } from "./sync-transfer";
import { DEFAULT_WEB_ROOT, sameOrigin, serveWeb, webSecurityHeaders, webToken } from "./web";
import { browseHostDirectories } from "./browse";
import {
  createHostBranch,
  hostBranches,
  switchHostBranch,
} from "./git-branches";
import {
  createHostWorktree,
  hostWorktrees,
  resolveHostWorktreeAsync,
} from "./git-worktrees";
import {
  createHostPath,
  hostFileDiff,
  hostGitAction,
  hostGitIndex,
  indexHostFiles,
  listHostFiles,
  readHostFile,
  searchHostContent,
  searchHostFiles,
  writeHostFile,
} from "./workspace";
import { WorkspaceCommands } from "./workspace-commands";
import { discoverCodexModels } from "../src/integrations/harness/providers/codex/codexCatalog";
import { discoverClaudeModels } from "../src/integrations/harness/providers/claude/claudeCatalog";
import { discoverCursorModels } from "../src/integrations/harness/providers/cursor/cursorCatalog";
import { discoverGrokModels } from "../src/integrations/harness/providers/grok/grokCatalog";
import { discoverOpenCodeModels } from "../src/integrations/harness/providers/opencode/opencodeCatalog";
import { discoverPiModels, discoverOmpModels } from "../src/integrations/harness/providers/pi/piCatalog";
import { discoverFxModels } from "../src/integrations/harness/providers/fx/fxCatalog";
import { discoverHermesModels } from "../src/integrations/harness/providers/hermes/hermesCatalog";
import { discoverAntigravityModels } from "../src/integrations/harness/providers/antigravity/antigravityCatalog";
import { discoverDevinModels } from "../src/integrations/harness/providers/devin/devinCatalog";
import { setHarnessModels, type AgentModel } from "../src/features/sessions/model/models";
import {
  resolveAntigravityBinary,
  resolveClaudeBinary,
  resolveCodexBinary,
  resolveCursorBinary,
  resolveDevinBinary,
  resolveFxBinary,
  resolveGrokBinary,
  resolveHermesBinary,
  resolveOmpBinary,
  resolveOpenCodeBinary,
  resolvePiBinary,
} from "../src/integrations/harness/core/child";

/**
 * The name people know this machine by. A Mac's network hostname comes from
 * whatever router it joined last (`Host-004.lan`), so it reads the Computer
 * Name instead; elsewhere the hostname, without a local DNS suffix.
 */
let knownName: string | undefined;
function machineName(): string {
  if (knownName) return knownName;
  if (process.platform === "darwin") {
    try {
      knownName = execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], {
        encoding: "utf8",
        timeout: 2_000,
      }).trim();
    } catch {
      /* falls back to the hostname */
    }
  }
  knownName ||= hostname().replace(/\.(local|lan|home|localdomain)$/i, "");
  return knownName;
}

const exec = promisify(execFile);
// Providers also add models server-side, without a CLI update.
const CATALOG_MAX_AGE_MS = 5 * 60_000;
const resolveBinary: Record<RemoteProvider, () => Promise<{ path: string }>> = {
  codex: () => resolveCodexBinary(),
  claude: () => resolveClaudeBinary(),
  cursor: () => resolveCursorBinary(),
  grok: () => resolveGrokBinary(),
  opencode: () => resolveOpenCodeBinary(),
  pi: () => resolvePiBinary(),
  omp: () => resolveOmpBinary(),
  fx: () => resolveFxBinary(),
  hermes: () => resolveHermesBinary(),
  antigravity: () => resolveAntigravityBinary(),
  devin: () => resolveDevinBinary(),
};
// A 1 MiB text file can expand to 6 MiB when JSON escapes control characters.
// Existing files.write sends both the original and replacement contents.
const MAX_BODY = 16 * 1024 * 1024;
const discoverModels: Record<RemoteProvider, (cwd: string) => Promise<AgentModel[]>> = {
  codex: discoverCodexModels,
  claude: discoverClaudeModels,
  cursor: discoverCursorModels,
  grok: discoverGrokModels,
  opencode: discoverOpenCodeModels,
  pi: discoverPiModels,
  omp: discoverOmpModels,
  fx: discoverFxModels,
  hermes: discoverHermesModels,
  antigravity: discoverAntigravityModels,
  devin: discoverDevinModels,
};

async function body(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid request");
  return value as Record<string, unknown>;
}

/** Identifies each installed provider CLI. An update changes its real path or
 * modification time, which invalidates the catalog the old version reported. */
async function providerBinaries(providers: RemoteProvider[]): Promise<string> {
  const binaries = await Promise.all(
    providers.map(async (provider) => {
      try {
        const file = await realpath((await resolveBinary[provider]()).path);
        return `${file}:${(await stat(file)).mtimeMs}`;
      } catch {
        return "";
      }
    }),
  );
  return binaries.join("\n");
}

export function createHostServer(
  engine: HostEngine,
  providers: RemoteProvider[],
  lifecycle?: (request: IncomingMessage, response: ServerResponse) => void,
  /** The command an agent on this host runs for the app CLI. */
  appCli?: string,
  /** Where the browser app's files are. */
  webRoot = DEFAULT_WEB_ROOT,
) {
  const catalogs = new Map<
    string,
    { binaries: string; probed: number; catalog: Promise<HostModelCatalog> }
  >();
  const transfers = new SyncTransfers();
  const workspace = new WorkspaceCommands(
    engine.store,
    (projectId, action) => engine.withIdleProject(projectId, action),
    (cwd, context, preferred) =>
      hostCommitMessage({
        cwd,
        context,
        installed: providers,
        providers: engine.providers,
        preferred,
      }),
    {
      busy: (path) => engine.worktreeSessions(path),
      release: (ids, projectCwd, keep) =>
        engine.releaseWorktreeSessions(ids, projectCwd, keep),
    },
    engine.checkpoints,
  );
  const employees = () => {
    if (!engine.employees) throw new Error("Colleagues are unavailable on this host");
    return engine.employees;
  };
  const accountLogins = () => {
    if (!engine.accountLogins) throw new Error("Signing in is unavailable on this host");
    return engine.accountLogins;
  };
  const rail = () => {
    if (!engine.rail) throw new Error("The project rail is unavailable on this host");
    return engine.rail;
  };
  const webApps = () => {
    if (!engine.webApps) throw new Error("Web apps are unavailable on this host");
    return engine.webApps;
  };
  const push = () => {
    if (!engine.push) throw new Error("Notifications are unavailable on this host");
    return engine.push;
  };
  const automations = () => {
    if (!engine.automations) throw new Error("Automations are unavailable on this host");
    return engine.automations;
  };
  const models = async (projectId?: unknown) => {
    const cwd =
      typeof projectId === "string"
        ? engine.store.project(projectId).cwd
        : homedir();
    const binaries = await providerBinaries(providers);
    const cached = catalogs.get(cwd);
    let catalog =
      cached?.binaries === binaries &&
      Date.now() - cached.probed < CATALOG_MAX_AGE_MS
        ? cached.catalog
        : undefined;
    if (!catalog) {
      catalog = (async () => {
        const result: HostModelCatalog = { models: {}, errors: {} };
        await Promise.all(
          providers.map(async (provider) => {
            try {
              const discovered = await discoverModels[provider](cwd);
              result.models[provider] = discovered;
              if (discovered.length) setHarnessModels(provider, discovered);
            } catch (error) {
              result.errors[provider] =
                error instanceof Error ? error.message : String(error);
            }
          }),
        );
        return result;
      })().then(
        (result) => {
          if (
            Object.keys(result.errors).length &&
            catalogs.get(cwd)?.catalog === catalog
          )
            catalogs.delete(cwd);
          return result;
        },
        (error) => {
          if (catalogs.get(cwd)?.catalog === catalog) catalogs.delete(cwd);
          throw error;
        },
      );
      catalogs.set(cwd, { binaries, probed: Date.now(), catalog });
    }
    return catalog;
  };
  return createServer(
    { requestTimeout: 20_000, headersTimeout: 10_000, maxHeaderSize: 8192 },
    async (request, response) => {
      if (request.url === "/lifecycle" && lifecycle) {
        lifecycle(request, response);
        return;
      }
      if (request.url === "/app" && engine.app && request.method === "POST" && !request.headers.origin) {
        // An agent's app CLI: its session credential is in the body.
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Cache-Control", "no-store");
        try {
          response.end(JSON.stringify(await engine.app.request(await body(request))));
        } catch {
          if (!response.destroyed)
            response.writeHead(400).end(JSON.stringify({ ok: false, error: "Invalid control request" }));
        }
        return;
      }
      // The browser app reaches the same methods at /web/rpc, from its own
      // page only, with the device credential in an HttpOnly cookie.
      const web = request.url === "/web/rpc";
      // A project's or a colleague's background image, for the signed-in
      // browser app.
      if (
        request.method === "GET" &&
        (request.url?.startsWith("/web/background?") || request.url?.startsWith("/web/colleague-background?"))
      ) {
        webSecurityHeaders(response);
        const token = webToken(request);
        const params = new URL(request.url, "http://host").searchParams;
        const signedIn = !!token && engine.store.authenticated(token);
        const image = !signedIn
          ? undefined
          : request.url.startsWith("/web/background?")
            ? engine.rail?.background(params.get("cwd") ?? "")
            : engine.employees?.backgroundFile(params.get("id") ?? "");
        if (!image) {
          response.writeHead(token && engine.store.authenticated(token) ? 404 : 401).end();
          return;
        }
        response.writeHead(200, { "Content-Type": image.type, "Cache-Control": "private, max-age=31536000, immutable" });
        createReadStream(image.path).pipe(response);
        return;
      }
      if (!web && (request.url === "/web" || request.url?.startsWith("/web/"))) {
        await serveWeb(request, response, (token) => engine.store.authenticated(token), webRoot);
        return;
      }
      if (web) webSecurityHeaders(response);
      response.setHeader("Content-Type", "application/json");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      try {
        // Desktop native HTTP supplies credentials. This endpoint intentionally
        // accepts no browser origin and provides no permissive CORS escape hatch.
        if (
          web
            ? request.method !== "POST" || !sameOrigin(request)
            : request.headers.origin ||
              request.method !== "POST" ||
              request.url !== "/rpc"
        ) {
          response
            .writeHead(403)
            .end(
              JSON.stringify({ error: "Unsupported request origin or route" }),
            );
          return;
        }
        const token = web
          ? webToken(request)
          : request.headers.authorization?.match(
              /^Bearer ([A-Za-z0-9_-]{43})$/,
            )?.[1];
        if (!token || !engine.store.authenticated(token)) {
          response.writeHead(401).end(
            JSON.stringify({
              error: "Device credential is invalid or revoked",
            }),
          );
          return;
        }
        const input = await body(request);
        // Reading a request body yields: a device may have been revoked since
        // the headers arrived. Reject it before dispatching any operation.
        if (!engine.store.authenticated(token)) {
          response.writeHead(401).end(JSON.stringify({
            error: "Device credential is invalid or revoked",
          }));
          return;
        }
        if (input.version !== HOST_PROTOCOL_VERSION)
          throw new Error("Incompatible protocol version");
        if (
          input.method !== "environment.describe" &&
          input.environmentId !== engine.store.environmentId
        )
          throw new Error(
            "Host identity changed; reconnect this machine explicitly",
          );
        const params =
          input.params &&
          typeof input.params === "object" &&
          !Array.isArray(input.params)
            ? (input.params as Record<string, unknown>)
            : {};
        let result: unknown;
        switch (input.method) {
          case "environment.describe":
            result = {
              protocolVersion: HOST_PROTOCOL_VERSION,
              environmentId: engine.store.environmentId,
              name: machineName(),
              platform: process.platform,
              version,
              // Older clients validate this list against Codex and Claude only.
              providers: providers.filter((provider) =>
                Array.isArray(params.supportedProviders)
                  ? params.supportedProviders.includes(provider)
                  : provider === "codex" || provider === "claude"
              ),
              ...(appCli ? { appCli } : {}),
              capabilities: [
                "sessions",
                "projects.browse",
                "models.list",
                "approvals",
                "questions",
                "diff",
                "git.branches",
                "git.switch",
                "git.createBranch",
                "git.worktrees",
                "git.worktreeCreate",
                "files.read",
                "files.list",
                "files.index",
                "workspace.run",
                "files.search",
                "files.searchContent",
                "files.create",
                "files.write",
                "git.index",
                "git.fileDiff",
                "git.action",
                "attachments.upload",
                "attachments.read",
                "sessions.draft",
                "sessions.plan",
                "sessions.import",
                "sessions.queue",
                "sessions.editLast",
                ...(engine.checkpoints ? ["sessions.review"] : []),
                ...(engine.employees ? ["employees", "employees.backgrounds", "employees.inbox", "employees.accounts"] : []),
                ...(engine.automations ? ["automations"] : []),
                ...(engine.app ? ["app"] : []),
                ...(engine.push ? ["push"] : []),
                ...(engine.push?.apnsEnabled() ? ["push.apns"] : []),
                ...(engine.rail ? ["projects.rail"] : []),
                ...(engine.webApps ? ["webApps"] : []),
                ...(engine.previews ? ["previews"] : []),
                "accounts",
                "accounts.refresh",
                "accounts.balance",
                "accounts.remove",
                ...(engine.accountLogins ? ["accounts.login", "accounts.import", "accounts.login.codex"] : []),
              ],
            };
            break;
          case "projects.list":
            result = engine.store.projects();
            break;
          case "accounts.list":
            result = engine.accountSummaries();
            break;
          case "accounts.refresh":
            result = await engine.refreshAccountUsage();
            break;
          case "accounts.balance":
            result = engine.setAccountBalanced(params);
            break;
          case "accounts.remove":
            result = engine.removeAccount(params);
            break;
          case "accounts.login":
            result = await accountLogins().start(params);
            break;
          case "accounts.loginCode":
            result = await accountLogins().finish(params);
            break;
          case "accounts.loginStatus":
            result = await accountLogins().status(params);
            break;
          case "accounts.loginCancel":
            accountLogins().cancel(params);
            result = {};
            break;
          case "accounts.found":
            result = await accountLogins().found();
            break;
          case "accounts.import":
            result = await accountLogins().adopt(params);
            break;
          case "projects.browse":
            result = await browseHostDirectories(params.path);
            break;
          case "projects.open":
            result = await engine.openProject(String(params.cwd ?? ""));
            break;
          case "models.list":
            result = await models(params.projectId);
            break;
          case "sessions.list": {
            const projectId = String(params.projectId ?? "");
            const project = engine.store.project(projectId);
            const summaries = engine.store.summaries(projectId);
            const paths = [...new Set(summaries.map((session) => session.cwd ?? project.cwd))];
            const branches = new Map(await Promise.all(paths.map(async (cwd) => {
              const branch = await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
                cwd, timeout: 2_000,
              }).then(({ stdout }) => stdout.trim()).catch(() => "");
              return [cwd, branch] as const;
            })));
            result = summaries.map((session) => ({
              ...session,
              repo: project.name,
              branch: branches.get(session.cwd ?? project.cwd) || undefined,
              worktreeCwd: session.cwd && session.cwd !== project.cwd
                ? session.cwd : undefined,
            }));
            break;
          }
          case "sessions.update": {
            const sessionId = String(params.sessionId ?? "");
            const current = engine.store.session(sessionId);
            if (current.projectId !== params.projectId)
              throw new Error("Session does not belong to this project");
            const patch: Parameters<typeof engine.updateSession>[1] = {};
            if (params.title !== undefined) {
              if (typeof params.title !== "string") throw new Error("Invalid session title");
              patch.title = params.title;
            }
            if (params.archived !== undefined) {
              if (typeof params.archived !== "boolean") throw new Error("Invalid archive value");
              patch.archived = params.archived;
            }
            if (params.pinned !== undefined) {
              if (typeof params.pinned !== "boolean") throw new Error("Invalid pin value");
              patch.pinned = params.pinned;
            }
            if (params.reviewed !== undefined) {
              if (params.reviewed !== true) throw new Error("Invalid review value");
              patch.reviewed = true;
            }
            if (params.linkedWorkItem !== undefined) {
              const item = params.linkedWorkItem;
              const parsed = item && typeof item === "object" && !Array.isArray(item)
                ? parseGithubWorkItemUrl(String((item as LinkedWorkItem).url ?? ""))
                : null;
              if (item !== null && (
                typeof item !== "object" || Array.isArray(item) ||
                !parsed ||
                parsed.kind !== (item as LinkedWorkItem).kind ||
                parsed.repo !== (item as LinkedWorkItem).repo ||
                parsed.number !== (item as LinkedWorkItem).number ||
                parsed.url !== (item as LinkedWorkItem).url
              )) throw new Error("Invalid linked work item");
              patch.linkedWorkItem = item as LinkedWorkItem | null;
            }
            if (params.usageLimit !== undefined) {
              const limit = params.usageLimit;
              if (limit === null) patch.usageLimit = null;
              else if (
                limit && typeof limit === "object" && !Array.isArray(limit) &&
                typeof (limit as { resumeAtReset?: unknown }).resumeAtReset === "boolean"
              )
                patch.usageLimit = { resumeAtReset: (limit as { resumeAtReset: boolean }).resumeAtReset };
              else throw new Error("Invalid usage limit change");
            }
            if (Object.keys(patch).length === 0) throw new Error("No session changes supplied");
            result = engine.updateSession(sessionId, patch);
            break;
          }
          case "sessions.delete": {
            const sessionId = String(params.sessionId ?? "");
            const current = engine.store.session(sessionId);
            if (current.projectId !== params.projectId)
              throw new Error("Session does not belong to this project");
            engine.store.deleteSession(sessionId);
            void engine.checkpoints?.forget(sessionId).catch(() => undefined);
            result = { deleted: true };
            break;
          }
          case "sessions.import":
            result = engine.importSession(params);
            break;
          case "sessions.sync": {
            const sessionId = String(params.sessionId ?? "");
            result = transfers.respond(
              sessionId,
              engine.store.sync(
                sessionId,
                Number.isSafeInteger(params.revision)
                  ? Number(params.revision)
                  : undefined,
              ),
            );
            break;
          }
          case "sessions.syncChunk":
            result = transfers.chunk(
              String(params.sessionId ?? ""),
              String(params.transfer ?? ""),
              Number(params.offset),
            );
            break;
          case "sessions.get": {
            const value = engine.store.session(String(params.sessionId ?? ""));
            result = value.revision === params.revision ? null : value;
            break;
          }
          case "events.read": {
            if (!Number.isSafeInteger(params.after) || Number(params.after) < 0)
              throw new Error("Invalid event cursor");
            result = engine.store.events(
              String(params.sessionId ?? ""),
              Number(params.after),
            );
            break;
          }
          case "commands.dispatch":
            result = engine.command(params);
            break;
          case "attachments.upload":
            result = writeAttachmentChunk(engine.store, params);
            break;
          case "attachments.read":
            result = readAttachmentChunk(engine.store, params);
            break;
          case "devices.revokeSelf":
            // Only the caller's own credential. Sessions and other devices
            // are unaffected; the host keeps running.
            result = { revoked: engine.store.revokeToken(token) };
            break;
          case "git.diff": {
            const project = engine.store.project(
              String(params.projectId ?? ""),
            );
            const diff = await exec(
              "git",
              [
                "-c",
                "core.pager=cat",
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "HEAD",
                "--",
              ],
              {
                cwd: await resolveHostWorktreeAsync(project.cwd, params.cwd),
                timeout: 10_000,
                maxBuffer: 2 * 1024 * 1024,
              },
            );
            result = diff.stdout;
            break;
          }
          case "git.branches": {
            const project = engine.store.project(
              String(params.projectId ?? ""),
            );
            result = await hostBranches(
              await resolveHostWorktreeAsync(project.cwd, params.cwd),
            );
            break;
          }
          case "git.switch": {
            const project = engine.store.project(
              String(params.projectId ?? ""),
            );
            const cwd = await resolveHostWorktreeAsync(project.cwd, params.cwd);
            result = await engine.withIdleProject(project.id, () =>
              switchHostBranch(cwd, params.branch, params.remote),
            );
            break;
          }
          case "git.createBranch": {
            const project = engine.store.project(
              String(params.projectId ?? ""),
            );
            const cwd = await resolveHostWorktreeAsync(project.cwd, params.cwd);
            result = await engine.withIdleProject(project.id, () =>
              createHostBranch(cwd, params.branch),
            );
            break;
          }
          case "git.worktrees": {
            const project = engine.store.project(
              String(params.projectId ?? ""),
            );
            result = await hostWorktrees(project.cwd);
            break;
          }
          case "git.worktreeCreate": {
            const project = engine.store.project(
              String(params.projectId ?? ""),
            );
            const cwd = await resolveHostWorktreeAsync(project.cwd, params.cwd);
            result = await engine.withIdleProject(project.id, () =>
              createHostWorktree(
                project.cwd,
                params.branch,
                params.base,
                params.existing,
                cwd,
              ),
            );
            workspace.invalidateRoots();
            break;
          }
          case "files.read": {
            const project = engine.store.project(
              String(params.projectId ?? ""),
            );
            result = await readHostFile(
              await resolveHostWorktreeAsync(project.cwd, params.cwd),
              params.path,
            );
            break;
          }
          case "files.list": {
            const project = engine.store.project(
              String(params.projectId ?? ""),
            );
            result = await listHostFiles(
              await resolveHostWorktreeAsync(project.cwd, params.cwd),
              params.path,
            );
            break;
          }
          case "files.index": {
            const project = engine.store.project(
              String(params.projectId ?? ""),
            );
            result = await indexHostFiles(
              await resolveHostWorktreeAsync(project.cwd, params.cwd),
            );
            break;
          }
          case "workspace.run":
            result = (await workspace.run(params.command, params.args)) ?? null;
            break;
          case "files.search": {
            const project = engine.store.project(
              String(params.projectId ?? ""),
            );
            result = await searchHostFiles(
              await resolveHostWorktreeAsync(project.cwd, params.cwd),
              params.query,
            );
            break;
          }
          case "files.searchContent": {
            const project = engine.store.project(
              String(params.projectId ?? ""),
            );
            result = await searchHostContent(
              await resolveHostWorktreeAsync(project.cwd, params.cwd),
              params,
            );
            break;
          }
          case "files.create": {
            const project = engine.store.project(
              String(params.projectId ?? ""),
            );
            result = await createHostPath(
              await resolveHostWorktreeAsync(project.cwd, params.cwd),
              params.parent,
              params.name,
              params.isDir,
            );
            break;
          }
          case "files.write": {
            const project = engine.store.project(
              String(params.projectId ?? ""),
            );
            result =
              (await writeHostFile(
                await resolveHostWorktreeAsync(project.cwd, params.cwd),
                params.path,
                params.expected,
                params.content,
              )) ?? null;
            break;
          }
          case "git.index": {
            const project = engine.store.project(
              String(params.projectId ?? ""),
            );
            result = await hostGitIndex(
              await resolveHostWorktreeAsync(project.cwd, params.cwd),
            );
            break;
          }
          case "git.fileDiff": {
            const project = engine.store.project(
              String(params.projectId ?? ""),
            );
            result = await hostFileDiff(
              await resolveHostWorktreeAsync(project.cwd, params.cwd),
              params.path,
              params.staged === true,
            );
            break;
          }
          case "git.action": {
            const project = engine.store.project(
              String(params.projectId ?? ""),
            );
            const cwd = await resolveHostWorktreeAsync(project.cwd, params.cwd);
            result =
              (await engine.withIdleProject(project.id, () =>
                hostGitAction(
                  cwd,
                  params.action,
                  params.path,
                  params.message,
                  params.content,
                ),
              )) ?? null;
            break;
          }
          case "employees.load":
            result = employees().load(params.mono);
            break;
          case "employees.read":
            result = employees().read(params.mono, params.path);
            break;
          case "employees.save":
            result = employees().save(params.mono, params.path, params.text, params.expectedHash);
            break;
          case "employees.import":
            result = employees().import(params.mono, params.files);
            break;
          case "employees.roster":
            result = employees().roster();
            break;
          case "employees.saveRoster":
            result = employees().saveRoster(params.roster, params.expectedRevision);
            break;
          case "employees.backgrounds":
            result = employees().backgrounds();
            break;
          case "employees.background":
            result = employees().background(params.mono);
            break;
          case "employees.setBackground":
            result = employees().setBackground(params.mono, params);
            break;
          case "employees.post":
            result = employees().post(
              params.mono,
              params.text,
              params.account,
              params.thread,
              params.control,
            );
            break;
          case "employees.accounts":
            result = employees().accounts();
            break;
          case "employees.setAccounts":
            employees().setAccounts(params);
            result = null;
            break;
          case "employees.inbox":
            result = employees().inbox(params.mono);
            break;
          case "employees.waiting":
            result = employees().waiting();
            break;
          case "employees.take":
            result = employees().take(params.id, params.by);
            break;
          case "employees.delivered":
            employees().delivered(params.id);
            result = null;
            break;
          case "employees.sessionUpsert":
            result = employees().transcripts.upsert(params);
            break;
          case "employees.sessionGet":
            result = employees().transcripts.get(params.sessionId);
            break;
          case "employees.sessionPage":
            result = employees().transcripts.page(params.sessionId, params);
            break;
          case "employees.sessionFind":
            result = employees().transcripts.find(params.sessionId, params.query);
            break;
          case "employees.sessionDelete":
            employees().transcripts.delete(params.sessionId);
            result = null;
            break;
          case "automations.list":
            result = automations().list();
            break;
          case "automations.upsert":
            result = automations().upsert(params.automation);
            break;
          case "automations.import":
            result = automations().upsert(params.automation, Date.now(), true);
            break;
          case "automations.delete":
            automations().delete(params.id);
            result = null;
            break;
          case "automations.runs":
            result = automations().runs(params.automationId);
            break;
          case "automations.recover":
            result = automations().recover(params.startedBefore, params.now, engine.store.deviceId(token));
            break;
          case "automations.runNow":
            result = automations().runNow(params.automationId, params.now, engine.store.deviceId(token));
            break;
          case "automations.claimDue":
            result = automations().claimDue(params, engine.store.deviceId(token));
            break;
          case "automations.claimEvent":
            result = automations().claimEvent(params, engine.store.deviceId(token));
            break;
          case "automations.updateRun":
            result = automations().updateRun(params);
            break;
          case "projects.rail":
            result = rail().get();
            break;
          case "projects.setRail":
            result = rail().set(params);
            break;
          case "projects.setBackground":
            result = rail().setBackground(params);
            break;
          case "projects.clearBackground":
            result = rail().clearBackground(params);
            break;
          case "previews.open":
            if (!engine.previews) throw new Error("Previews need Tailscale on this host");
            result = await engine.previews.open(params);
            break;
          case "webApps.get":
            result = webApps().get();
            break;
          case "webApps.set":
            result = webApps().set(params);
            break;
          case "webApps.session":
            result = webApps().session(params);
            break;
          case "webApps.setSession":
            result = webApps().setSession(params);
            break;
          case "push.key":
            result = { publicKey: push().publicKey() };
            break;
          case "push.subscribe":
            result = push().subscribe(params.subscription);
            break;
          case "push.unsubscribe":
            result = push().unsubscribe(params.endpoint);
            break;
          case "push.registerApns":
            result = push().registerApns(params);
            break;
          case "push.unregisterApns":
            result = push().unregisterApns(params.token);
            break;
          case "app.take":
            result = engine.app?.take(params.sessionId, engine.store.deviceId(token)) ?? [];
            break;
          case "app.reply":
            result = { delivered: engine.app?.reply(params.id, params.response) ?? false };
            break;
          default:
            throw new Error("Unsupported host method");
        }
        response.end(JSON.stringify({ result }));
      } catch (error) {
        if (!response.destroyed)
          response.writeHead(400).end(
            JSON.stringify({
              error:
                error instanceof Error ? error.message : "Host request failed",
            }),
          );
      }
    },
  );
}
