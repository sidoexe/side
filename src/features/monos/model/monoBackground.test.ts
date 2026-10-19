// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { saveProjectChatBackgroundSettings } from "../../projects/model/projectChatBackground";
import { monoBackgroundKey, monoChatBackground } from "./monoBackground";

afterEach(() => localStorage.clear());

it("shows an Employee's background as it was set", () => {
  expect(monoChatBackground("a")).toBeNull();
  saveProjectChatBackgroundSettings(monoBackgroundKey("a"), {
    path: "/bg/mono.png",
    emptyOpacity: 0.6,
    sessionOpacity: 0.5,
    scope: "empty",
    effect: "dither",
  });
  expect(monoChatBackground("a")).toEqual({
    path: "/bg/mono.png",
    emptyOpacity: 0.6,
    sessionOpacity: 0.5,
    scope: "empty",
    effect: "dither",
  });
});
