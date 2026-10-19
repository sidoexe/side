import { useMemo, useSyncExternalStore } from "react";
import {
  cachedRemoteReviewAgents,
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

/**
 * Every session in three columns, as the rail's To review, Working and
 * Checked list them. A host runs its own sessions, so its finished and
 * waiting ones come from the list it reports rather than from this desktop.
 */
export function useSessionBoard(
  liveAgents: LiveAgent[],
  projectPaths: readonly string[],
  onSelectAgent?: (sessionId: string) => void,
  onSelectRemoteSession?: (project: string, sessionId: string) => void,
): SessionBoard {
  const enabled = useSyncExternalStore(
    subscribeLiveAgentsEnabled,
    loadLiveAgentsEnabled,
  );
  const remoteStatus = useRemoteProjectsStatus(projectPaths);
  const remoteReview = useMemo(() => {
    if (!enabled || !onSelectRemoteSession) return [];
    const open = new Set(
      liveAgents.flatMap((agent) => remoteSessionFor(agent.id) ?? []),
    );
    return cachedRemoteReviewAgents([...projectPaths]).filter(
      ({ agent }) => !open.has(agent.id),
    );
    // `remoteStatus` changes whenever a host list does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, onSelectRemoteSession, liveAgents, projectPaths, remoteStatus]);
  const remoteProjects = new Map(
    remoteReview.map(({ project, agent }) => [agent.id, project]),
  );
  const storedChecks = useSyncExternalStore(
    subscribeCheckedSessions,
    checkedSessions,
  );
  return {
    enabled,
    review: [
      ...liveAgents.filter((agent) => agent.needsApproval || agent.done),
      ...remoteReview.map(({ agent }) => agent),
    ],
    working: liveAgents.filter((agent) => !agent.needsApproval && !agent.done),
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
      const project = remoteProjects.get(agent.id);
      // A host keeps its own sessions; only this desktop's are listed as checked.
      if (project) return void markRemoteSessionReviewed(project, agent.id);
      markSessionsReviewed([agent.id]);
      const { id, cwd, title, harness } = agent;
      noteSessionsChecked([{ id, cwd, title, harness }]);
    },
  };
}
