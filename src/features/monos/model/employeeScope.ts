import { copyFilesHere, copyFilesToHost, employeeHome } from "./employeeStorage";
import { copyTranscriptHere, copyTranscriptToHost } from "./employeeTranscripts";
import { findMono, updateMono } from "./mono";
import { notifyMonoFilesChanged } from "./monoFiles";

/**
 * Moves one employee between the home machine and this computer. Its files
 * and conversation are copied over before the switch, so it carries on where
 * it was; the copy it leaves behind is no longer read. Without a home machine
 * every employee is this computer's already, and nothing moves.
 */
export async function setEmployeeLocalOnly(monoId: string, localOnly: boolean): Promise<void> {
  const mono = findMono(monoId);
  if (!mono || !!mono.localOnly === localOnly) return;
  const home = await employeeHome();
  if (home) {
    const legacy = mono.legacyProject ?? null;
    if (localOnly) {
      await copyFilesHere(home, monoId, legacy);
      if (mono.sessionId) await copyTranscriptHere(home, mono.sessionId);
    } else {
      await copyFilesToHost(home, monoId, legacy);
      if (mono.sessionId) await copyTranscriptToHost(home, mono.sessionId);
    }
  }
  updateMono(monoId, ({ localOnly: _, ...rest }) => (localOnly ? { ...rest, localOnly: true } : rest));
  notifyMonoFilesChanged();
}
