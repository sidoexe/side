const PERSONAL_INSTRUCTIONS_KEY = "monocode.personalInstructions";

/** Caps what one paste can make every new chat carry. */
export const PERSONAL_INSTRUCTIONS_MAX_LENGTH = 8000;

/** What the user wants every agent to know, whatever the provider. */
export function loadPersonalInstructions(): string {
  try {
    return localStorage.getItem(PERSONAL_INSTRUCTIONS_KEY) ?? "";
  } catch {
    return "";
  }
}

export function savePersonalInstructions(text: string) {
  const value = text.slice(0, PERSONAL_INSTRUCTIONS_MAX_LENGTH);
  try {
    if (value.trim()) localStorage.setItem(PERSONAL_INSTRUCTIONS_KEY, value);
    else localStorage.removeItem(PERSONAL_INSTRUCTIONS_KEY);
  } catch {
    // private mode / quota
  }
}

/**
 * The block sIDE adds to the first turn a provider sees, so the agent reads
 * the user's standing preferences before their request. Empty text adds
 * nothing.
 */
export function personalInstructionsContext(
  text = loadPersonalInstructions(),
): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return [
    "<personal_instructions>",
    "The user set these standing instructions for every conversation. Follow them unless this request says otherwise.",
    "",
    trimmed,
    "</personal_instructions>",
  ].join("\n");
}
