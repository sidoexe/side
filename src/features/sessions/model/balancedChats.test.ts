// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  balancedChatIds,
  saveChatBalanced,
  subscribeBalancedChats,
} from "./balancedChats";

beforeEach(() => {
  localStorage.clear();
});

describe("balanced chats", () => {
  it("turns Balanced on and off per chat, and tells subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBalancedChats(listener);
    saveChatBalanced("a", true);
    saveChatBalanced("b", true);
    saveChatBalanced("a", true);
    expect(balancedChatIds()).toEqual(["b", "a"]);
    saveChatBalanced("b", false);
    expect(balancedChatIds()).toEqual(["a"]);
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
  });

  it("reads damaged storage as none", () => {
    localStorage.setItem("monocode.balancedChats.v1", "{");
    expect(balancedChatIds()).toEqual([]);
    localStorage.setItem("monocode.balancedChats.v1", '["a", 3]');
    expect(balancedChatIds()).toEqual(["a"]);
  });
});
