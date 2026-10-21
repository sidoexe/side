// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  loadPersonalInstructions,
  PERSONAL_INSTRUCTIONS_MAX_LENGTH,
  personalInstructionsContext,
  savePersonalInstructions,
} from "./personalInstructions";

describe("personal instructions", () => {
  beforeEach(() => localStorage.clear());

  it("saves, loads, and clears the text", () => {
    expect(loadPersonalInstructions()).toBe("");
    savePersonalInstructions("Answer in French.");
    expect(loadPersonalInstructions()).toBe("Answer in French.");
    savePersonalInstructions("   ");
    expect(loadPersonalInstructions()).toBe("");
  });

  it("caps what it keeps", () => {
    savePersonalInstructions("x".repeat(PERSONAL_INSTRUCTIONS_MAX_LENGTH + 10));
    expect(loadPersonalInstructions()).toHaveLength(
      PERSONAL_INSTRUCTIONS_MAX_LENGTH,
    );
  });

  it("wraps the saved text for the agent and adds nothing when empty", () => {
    expect(personalInstructionsContext()).toBeUndefined();
    savePersonalInstructions("  Prefer small commits.\n");
    const context = personalInstructionsContext();
    expect(context).toMatch(/^<personal_instructions>\n/);
    expect(context).toContain(
      "\nPrefer small commits.\n</personal_instructions>",
    );
  });
});
