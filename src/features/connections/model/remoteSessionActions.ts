import type { Attachment, ComposerTurnOptions, PlanBuildTarget } from "../../sessions/model/session";
import type { ApprovalDecision, UserQuestionReply } from "../../../integrations/harness";

type RemoteActions = {
  buildPlan: (blockId: string, target?: PlanBuildTarget) => void;
  submit: (text: string, attachments: Attachment[], options?: ComposerTurnOptions) => boolean | void;
  saveDraft: (text: string, attachments: Attachment[]) => boolean | void;
  stop: () => void;
  compact: () => boolean;
  approve: (requestId: number, decision: ApprovalDecision) => void;
  answer: (requestId: number, reply: UserQuestionReply) => void;
  /** Present when the host can edit a ready plan (`sessions.planEdit`). */
  editPlan?: (blockId: string, text: string) => void;
};

const actions = new Map<string, RemoteActions>();

export function registerRemoteSessionActions(shellId: string, value: RemoteActions) {
  actions.set(shellId, value);
  return () => {
    if (actions.get(shellId) === value) actions.delete(shellId);
  };
}

export function buildRemotePlan(shellId: string, blockId: string, target?: PlanBuildTarget) {
  actions.get(shellId)?.buildPlan(blockId, target);
}

/** Whether a host session's plan can be edited from its plan tab. */
export function canEditRemotePlan(shellId: string): boolean {
  return !!actions.get(shellId)?.editPlan;
}

export function editRemotePlan(shellId: string, blockId: string, text: string) {
  actions.get(shellId)?.editPlan?.(blockId, text);
}

export function remoteSessionActions(shellId: string): RemoteActions | undefined {
  return actions.get(shellId);
}
