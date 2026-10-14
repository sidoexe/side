import { describe, expect, it } from "vitest";
import {
  DEFAULT_WEB_APP,
  newWebApp,
  normalizeWebAppUrl,
  removeWebApp,
  webAppName,
} from "./webApps";

describe("web apps", () => {
  it("reads a typed address as a web page", () => {
    expect(normalizeWebAppUrl("linear.app")).toBe("https://linear.app/");
    expect(normalizeWebAppUrl(" https://app.slack.com/client ")).toBe(
      "https://app.slack.com/client",
    );
    expect(normalizeWebAppUrl("http://localhost:3000")).toBe(
      "http://localhost:3000/",
    );
    expect(normalizeWebAppUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeWebAppUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeWebAppUrl("   ")).toBeNull();
  });

  it("names an app after its site", () => {
    expect(webAppName("https://linear.app/")).toBe("Linear");
    expect(webAppName("https://app.slack.com/client")).toBe("Slack");
    expect(webAppName("https://www.notion.so/")).toBe("Notion");
  });

  it("numbers a second account on the same site", () => {
    const second = newWebApp([DEFAULT_WEB_APP], "https://linear.app/");
    expect(second.name).toBe("Linear 2");
    expect(second.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(newWebApp([DEFAULT_WEB_APP], "https://notion.so/").name).toBe(
      "Notion",
    );
  });

  it("never removes the last app", () => {
    const notion = { id: "n", name: "Notion", url: "https://notion.so/" };
    expect(removeWebApp([DEFAULT_WEB_APP, notion], "default")).toEqual([
      notion,
    ]);
    expect(removeWebApp([notion], "n")).toEqual([DEFAULT_WEB_APP]);
  });
});
