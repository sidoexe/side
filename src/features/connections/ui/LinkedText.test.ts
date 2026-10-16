import { expect, test, vi } from "vitest";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));

import { linkParts } from "./LinkedText";

test("the Tailscale sign-in link in an SSH error is a link", () => {
  const error =
    "SSH connection failed: # Tailscale SSH requires an additional check.\n# To authenticate, visit: https://login.tailscale.com/a/l7f20b0e33d102\nConnection to 100.79.195.105 port 22 timed out.";
  const links = linkParts(error).filter((part) => part.url);
  expect(links.map((part) => part.url)).toEqual(["https://login.tailscale.com/a/l7f20b0e33d102"]);
  expect(linkParts(error).map((part) => part.text).join("")).toBe(error);
});

test("trailing punctuation stays out of the link", () => {
  expect(linkParts("Visit https://example.com/a.").map((part) => part.url)).toEqual([
    undefined,
    "https://example.com/a",
    undefined,
  ]);
});

test("text without links stays as it is", () => {
  expect(linkParts("Offline")).toEqual([{ text: "Offline" }]);
});
