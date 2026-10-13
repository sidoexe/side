import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import {
  rememberRemoteSession,
  remoteRequest,
  useRemoteMachines,
} from "../../features/connections/model/connections";
import {
  HOME_MACHINE_CHANGED,
  migrateProjectToHome,
  projectsToMigrate,
  recordMigratedProject,
  resolveHomeMachine,
  retargetOpenSessions,
  saveMigrationReport,
} from "../../features/connections/model/homeMachine";
import type { HostProject, RemoteMachine } from "../../features/connections/model/protocol";
import { rememberRemoteProject } from "../../features/connections/model/remoteProjects";
import {
  archiveProject,
  knownProjectPaths,
  loadRecents,
  replaceProjectPath,
  type RecentProject,
} from "../../features/projects/model/recents";
import {
  getSession,
  listSessionsByProject,
} from "../../features/sessions/data/sessionStore";
import { newDefaultSession, type Session } from "../../features/sessions/model/session";
import { updateSessionState } from "../model/sessionState";

const RETRY_MS = 60_000;

/** The home machine, and the one-time move of every local project onto it.
 * A project with a turn still running locally waits for the next pass. */
export function useHomeMachine({
  sessionsRef,
  setSessions,
  setRecents,
  onProjectMoved,
}: {
  sessionsRef: RefObject<Session[]>;
  setSessions: Dispatch<SetStateAction<Session[]>>;
  setRecents: Dispatch<SetStateAction<RecentProject[]>>;
  /** A local project now lives on the home machine under `key`. */
  onProjectMoved: (path: string, key: string) => void;
}): RemoteMachine | undefined {
  const { machines, loaded } = useRemoteMachines();
  const [choiceVersion, setChoiceVersion] = useState(0);
  const home = loaded ? resolveHomeMachine(machines) : undefined;
  const running = useRef(false);
  const onProjectMovedRef = useRef(onProjectMoved);
  onProjectMovedRef.current = onProjectMoved;

  useEffect(() => {
    const changed = () => setChoiceVersion((value) => value + 1);
    window.addEventListener(HOME_MACHINE_CHANGED, changed);
    return () => window.removeEventListener(HOME_MACHINE_CHANGED, changed);
  }, []);

  useEffect(() => {
    if (!home) return;
    let disposed = false;
    const pass = async () => {
      if (running.current) return;
      running.current = true;
      try {
        for (const path of projectsToMigrate(knownProjectPaths())) {
          if (disposed) return;
          const busy = sessionsRef.current.some(
            (session) => session.cwd === path && session.busy,
          );
          if (busy) continue;
          const result = await migrateProjectToHome(home, path, {
            openProject: (cwd) =>
              remoteRequest<HostProject>(home.id, "projects.open", { cwd }),
            importSession: (params) =>
              remoteRequest(home.id, "sessions.import", params),
            listSessions: listSessionsByProject,
            getSession,
          });
          if (disposed) return;
          if (result.kind === "missing") {
            archiveProject(path);
            recordMigratedProject(path, "archived");
            saveMigrationReport(path, { archived: true, error: result.error });
            setRecents(loadRecents());
            continue;
          }
          rememberRemoteProject(home.environmentId, result.project);
          let blocked = false;
          updateSessionState(sessionsRef, setSessions, (sessions) => {
            const next = retargetOpenSessions(sessions, path, result.key, (cwd) =>
              newDefaultSession(cwd),
            );
            blocked = next.blocked;
            if (blocked) return sessions;
            for (const id of next.remote) rememberRemoteSession(id, id);
            return next.sessions;
          });
          // A turn started while the import ran: the project moves next pass.
          if (blocked) continue;
          setRecents(replaceProjectPath(path, result.key));
          recordMigratedProject(path, result.key);
          onProjectMovedRef.current(path, result.key);
          saveMigrationReport(path, {
            imported: result.imported,
            skipped: result.skipped,
            failed: result.failed,
          });
        }
      } finally {
        running.current = false;
      }
    };
    void pass();
    const timer = setInterval(() => void pass(), RETRY_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [home?.id, home?.environmentId, choiceVersion]);

  return home;
}
