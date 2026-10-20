import { useMemo, useSyncExternalStore } from "react";
import {
  allRemoteProjects,
  remoteProjectFor,
  remoteProjectsSnapshot,
  subscribeRemoteProjects,
} from "../../connections/model/remoteProjects";
import {
  cachedRemoteBoardAgents,
  markRemoteSessionReviewed,
  remoteSessionFor,
  useRemoteProjectsStatus,
} from "../../connections/model/connections";
import {
  loadLiveAgentsEnabled,
  subscribeLiveAgentsEnabled,
} from "../../settings/model/settings";
import type { LiveAgent } from "../model/liveAgents";
import {
  checkedSessions,
  noteSessionsChecked,
  subscribeCheckedSessions,
  type CheckedSession,
} from "../model/sessionChecked";
import { markSessionsReviewed } from "../model/sessionReview";

export type SessionBoard = {
  enabled: boolean;
  /** Waiting on the user or finished, across every project and host. */
  review: LiveAgent[];
  working: LiveAgent[];
  /** Checked on this desktop, last checked first. */
  checked: CheckedSession[];
  onSelect: (sessionId: string) => void;
  onMarkChecked: (agent: LiveAgent) => void;
};

function isWorking(agent: LiveAgent): boolean {
  return !agent.needsApproval && !agent.done;
}

/**
 * Every session in three columns, as the rail's To review, Working and
 * Checked list them. A host runs its own sessions, so its running, finished
 * and waiting ones come from the list it reports rather than from this desktop.
 */
export function useSessionBoard(
  liveAgents: LiveAgent[],
  projectPaths: readonly string[],
  onSelectAgent?: (sessionId: string) => void,
  onSelectRemoteSession?: (project: string, sessionId: string) => void,
  /** Rows only the board lists, such as a colleague's own chat: working, or
   * waiting on the user. */
  extraRows: readonly LiveAgent[] = [],
  /** Checks one of the extra rows that has settled. */
  onCheckExtra?: (agent: LiveAgent) => void,
): SessionBoard {
  const enabled = useSyncExternalStore(
    subscribeLiveAgentsEnabled,
    loadLiveAgentsEnabled,
  );
  // A host's waiting session counts whichever project it belongs to, not only
  // the rail's recent ones.
  const remoteProjectsKey = useSyncExternalStore(
    subscribeRemoteProjects,
    remoteProjectsSnapshot,
  );
  const boardPaths = useMemo(() => {
    const seen = new Set(
      projectPaths.flatMap((path) => remoteProjectFor(path)?.key ?? []),
    );
    const others = allRemoteProjects().flatMap(({ key }) =>
      seen.has(key) ? [] : key,
    );
    return [...projectPaths, ...others];
    // `remoteProjectsKey` moves with the remembered projects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPaths, remoteProjectsKey]);
  const remoteStatus = useRemoteProjectsStatus(boardPaths);
  const remoteRows = useMemo(() => {
    if (!enabled || !onSelectRemoteSession) return [];
    const open = new Set(
      liveAgents.flatMap((agent) => remoteSessionFor(agent.id) ?? []),
    );
    return cachedRemoteBoardAgents(boardPaths).filter(
      ({ agent }) => !open.has(agent.id),
    );
    // `remoteStatus` changes whenever a host list does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, onSelectRemoteSession, liveAgents, boardPaths, remoteStatus]);
  const remoteProjects = new Map(
    remoteRows.map(({ project, agent }) => [agent.id, project]),
  );
  const storedChecks = useSyncExternalStore(
    subscribeCheckedSessions,
    checkedSessions,
  );
  return {
    enabled,
    review: [
      ...liveAgents.filter((agent) => agent.needsApproval || agent.done),
      ...extraRows.filter((agent) => !isWorking(agent)),
      ...remoteRows.flatMap(({ agent }) => (isWorking(agent) ? [] : agent)),
    ].sort((a, b) => Number(b.needsApproval) - Number(a.needsApproval)),
    working: [
      ...liveAgents,
      ...extraRows,
      ...remoteRows.map(({ agent }) => agent),
    ].filter(isWorking),
    // One that works or waits again leaves the list until it is checked again.
    checked: enabled
      ? storedChecks.filter(
          (entry) => !liveAgents.some((agent) => agent.id === entry.id),
        )
      : [],
    onSelect: (sessionId) => {
      const project = remoteProjects.get(sessionId);
      if (!project) return onSelectAgent?.(sessionId);
      // Opening one is not checking it, as with a local session.
      onSelectRemoteSession?.(project, sessionId);
    },
    onMarkChecked: (agent) => {
      if (extraRows.some((row) => row.id === agent.id))
        return void onCheckExtra?.(agent);
      const project = remoteProjects.get(agent.id);
      // A host keeps its own sessions; only this desktop's are listed as checked.
      if (project) return void markRemoteSessionReviewed(project, agent.id);
      markSessionsReviewed([agent.id]);
      const { id, cwd, title, harness } = agent;
      noteSessionsChecked([{ id, cwd, title, harness }]);
    },
  };
}
