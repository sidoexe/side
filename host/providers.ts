import * as codex from "../src/integrations/harness/providers/codex/codex";
import * as claude from "../src/integrations/harness/providers/claude/claude";
import * as cursor from "../src/integrations/harness/providers/cursor/cursor";
import * as grok from "../src/integrations/harness/providers/grok/grok";
import * as opencode from "../src/integrations/harness/providers/opencode/opencode";
import * as pi from "../src/integrations/harness/providers/pi/pi";
import * as omp from "../src/integrations/harness/providers/omp/omp";
import * as fx from "../src/integrations/harness/providers/fx/fx";
import * as hermes from "../src/integrations/harness/providers/hermes/hermes";
import * as antigravity from "../src/integrations/harness/providers/antigravity/antigravity";
import * as devin from "../src/integrations/harness/providers/devin/devin";
import type {
  SendTurnInput,
  CompactContextInput,
  ApprovalDecision,
  RewindLastTurnInput,
  RewindLastTurnResult,
  SteerTurnInput,
} from "../src/integrations/harness/core/types";
import type { UserQuestionReply } from "../src/features/sessions/model/userQuestion";
import type { RemoteProvider } from "../src/features/connections/model/protocol";
import type { GeneratedSessionTitle } from "../src/features/sessions/model/sessionTitle";
import { generateCodexSessionTitle } from "../src/integrations/harness/providers/codex/codexTitle";
import { generateClaudeSessionTitle } from "../src/integrations/harness/providers/claude/claudeTitle";
import { generateCodexBranchName } from "../src/integrations/harness/providers/codex/codexGit";
import { generateClaudeBranchName } from "../src/integrations/harness/providers/claude/claudeGit";
import { generateCursorBranchName } from "../src/integrations/harness/providers/cursor/cursorGit";
import { generateGrokBranchName } from "../src/integrations/harness/providers/grok/grokGit";
import { generateOpenCodeBranchName } from "../src/integrations/harness/providers/opencode/opencodeGit";
import { runOmpTextPrompt, runPiTextPrompt } from "../src/integrations/harness/providers/pi/piText";
import { runDevinTextPrompt } from "../src/integrations/harness/providers/devin/devinText";
import { generateCursorSessionTitle } from "../src/integrations/harness/providers/cursor/cursorTitle";
import { generateGrokSessionTitle } from "../src/integrations/harness/providers/grok/grokTitle";
import { generateOpenCodeSessionTitle } from "../src/integrations/harness/providers/opencode/opencodeTitle";
import {
  generatePiSessionTitle,
  generateOmpSessionTitle,
} from "../src/integrations/harness/providers/pi/piTitle";
import {
  PI_FLAVOR,
  OMP_FLAVOR,
} from "../src/integrations/harness/providers/pi/piFlavor";
import { respondQuestion as respondPiQuestion } from "../src/integrations/harness/providers/pi/piFamily";
import { runCodexTextPrompt } from "../src/integrations/harness/providers/codex/codexText";
import { runClaudeTextPrompt } from "../src/integrations/harness/providers/claude/claudeText";
import { runCursorTextPrompt } from "../src/integrations/harness/providers/cursor/cursorText";
import { runGrokTextPrompt } from "../src/integrations/harness/providers/grok/grokText";
import { runOpenCodeTextPrompt } from "../src/integrations/harness/providers/opencode/opencodeText";

export interface HostProvider {
  send(input: SendTurnInput): Promise<void>;
  compact?(input: CompactContextInput): Promise<void>;
  cancel(id: string): Promise<void>;
  /** Adds a message to the running turn; absent when the provider cannot. */
  steer?(input: SteerTurnInput): Promise<void>;
  /** Drops the last user turn from provider state, for edit-and-resend. */
  rewind?(input: RewindLastTurnInput): Promise<RewindLastTurnResult>;
  stop(id: string): Promise<void>;
  bind(id: string, providerId: string, cwd: string, accountId?: string): void;
  approve(id: string, request: number, decision: ApprovalDecision): void;
  answer(id: string, request: number, reply: UserQuestionReply): void;
  generateTitle?(input: {
    sessionId: string;
    cwd: string;
    message: string;
  }): Promise<GeneratedSessionTitle | null>;
  generateBranchName?(cwd: string, message: string): Promise<string | null>;
  /** One-shot text prompt, for commit messages. */
  runText?(input: {
    cwd: string;
    prompt: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<string>;
}

export const hostProviders: Record<RemoteProvider, HostProvider> = {
  codex: {
    runText: runCodexTextPrompt,
    steer: codex.steerCodexTurn,
    rewind: codex.rewindCodexLastTurn,
    send: codex.sendCodexTurn,
    compact: codex.compactCodexContext,
    cancel: codex.cancelCodexTurn,
    stop: codex.forgetCodexSession,
    bind: codex.bindCodexSession,
    approve: codex.respondCodexApproval,
    answer: codex.respondCodexQuestion,
    generateTitle: generateCodexSessionTitle,
    generateBranchName: generateCodexBranchName,
  },
  claude: {
    runText: runClaudeTextPrompt,
    steer: claude.steerClaudeTurn,
    send: claude.sendClaudeTurn,
    compact: claude.compactClaudeContext,
    cancel: claude.cancelClaudeTurn,
    stop: claude.forgetClaudeSession,
    bind: claude.bindClaudeSession,
    approve: claude.respondClaudeApproval,
    answer: claude.respondClaudeQuestion,
    generateTitle: generateClaudeSessionTitle,
    generateBranchName: generateClaudeBranchName,
  },
  cursor: {
    runText: runCursorTextPrompt,
    steer: cursor.steerCursorTurn,
    send: cursor.sendCursorTurn,
    cancel: cursor.cancelCursorTurn,
    stop: cursor.forgetCursorSession,
    bind: cursor.bindCursorSession,
    approve: cursor.respondCursorApproval,
    answer: cursor.respondCursorQuestion,
    generateTitle: generateCursorSessionTitle,
    generateBranchName: generateCursorBranchName,
  },
  grok: {
    runText: runGrokTextPrompt,
    send: grok.sendGrokTurn,
    compact: grok.compactGrokContext,
    cancel: grok.cancelGrokTurn,
    stop: grok.forgetGrokSession,
    bind: grok.bindGrokSession,
    approve: grok.respondGrokApproval,
    answer: grok.respondGrokQuestion,
    generateTitle: generateGrokSessionTitle,
    generateBranchName: generateGrokBranchName,
  },
  opencode: {
    runText: runOpenCodeTextPrompt,
    steer: opencode.steerOpenCodeTurn,
    rewind: opencode.rewindOpenCodeLastTurn,
    send: opencode.sendOpenCodeTurn,
    compact: opencode.compactOpenCodeContext,
    cancel: opencode.cancelOpenCodeTurn,
    stop: opencode.forgetOpenCodeSession,
    bind: opencode.bindOpenCodeSession,
    approve: opencode.respondOpenCodeApproval,
    answer: opencode.respondOpenCodeQuestion,
    generateTitle: generateOpenCodeSessionTitle,
    generateBranchName: generateOpenCodeBranchName,
  },
  pi: {
    runText: runPiTextPrompt,
    steer: pi.steerPiTurn,
    rewind: pi.rewindPiLastTurn,
    send: pi.sendPiTurn,
    compact: pi.compactPiContext,
    cancel: pi.cancelPiTurn,
    stop: pi.forgetPiSession,
    bind: pi.bindPiSession,
    approve: pi.respondPiApproval,
    answer: (id, request, reply) =>
      respondPiQuestion(PI_FLAVOR, id, request, reply),
    generateTitle: generatePiSessionTitle,
  },
  omp: {
    runText: runOmpTextPrompt,
    steer: omp.steerOmpTurn,
    rewind: omp.rewindOmpLastTurn,
    send: omp.sendOmpTurn,
    compact: omp.compactOmpContext,
    cancel: omp.cancelOmpTurn,
    stop: omp.forgetOmpSession,
    bind: omp.bindOmpSession,
    approve: omp.respondOmpApproval,
    answer: (id, request, reply) =>
      respondPiQuestion(OMP_FLAVOR, id, request, reply),
    generateTitle: generateOmpSessionTitle,
  },
  fx: {
    send: fx.sendFxTurn,
    cancel: fx.cancelFxTurn,
    stop: fx.forgetFxSession,
    bind: fx.bindFxSession,
    approve: fx.respondFxApproval,
    answer: unsupportedQuestion,
  },
  hermes: {
    steer: hermes.steerHermesTurn,
    send: hermes.sendHermesTurn,
    cancel: hermes.cancelHermesTurn,
    stop: hermes.forgetHermesSession,
    bind: hermes.bindHermesSession,
    approve: hermes.respondHermesApproval,
    answer: unsupportedQuestion,
  },
  antigravity: {
    send: antigravity.sendAntigravityTurn,
    cancel: antigravity.cancelAntigravityTurn,
    stop: antigravity.forgetAntigravitySession,
    bind: antigravity.bindAntigravitySession,
    approve: antigravity.respondAntigravityApproval,
    answer: unsupportedQuestion,
  },
  devin: {
    runText: runDevinTextPrompt,
    send: devin.sendDevinTurn,
    compact: devin.compactDevinContext,
    cancel: devin.cancelDevinTurn,
    stop: devin.forgetDevinSession,
    bind: devin.bindDevinSession,
    approve: devin.respondDevinApproval,
    answer: unsupportedQuestion,
    generateTitle: ({ sessionId }) =>
      devin
        .waitForDevinSessionTitle(sessionId)
        .then((title) => (title ? { title, workItem: null } : null)),
  },
};

function unsupportedQuestion(): never {
  throw new Error("This provider does not support questions");
}
