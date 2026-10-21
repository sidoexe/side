// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  arrangeColumn,
  boardOrder,
  reorderBoardColumn,
  settleBoardOrder,
} from "./boardOrder";

const columns = (
  working: string[],
  review: string[] = [],
  checked: string[] = [],
) => ({ working, review, checked });

describe("board order", () => {
  beforeEach(() => localStorage.clear());

  it("puts a card new to a column on top", () => {
    const first = settleBoardOrder(columns(["a", "b"]), boardOrder());
    expect(first.working).toEqual(["a", "b"]);
    expect(settleBoardOrder(columns(["b", "a", "c"]), first).working).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("keeps a dragged order and survives a reload", () => {
    reorderBoardColumn("review", ["b", "a"]);
    expect(
      JSON.parse(localStorage.getItem("monocode.boardOrder")!).review,
    ).toEqual(["b", "a"]);
    const items = [{ id: "a" }, { id: "b" }, { id: "new" }];
    expect(
      arrangeColumn(items, boardOrder().review).map(({ id }) => id),
    ).toEqual(["new", "b", "a"]);
  });

  it("sends a card that comes back to a column on top", () => {
    let order = settleBoardOrder(columns(["a", "b"]), boardOrder());
    order = settleBoardOrder(columns(["b"], ["a"]), order);
    expect(order.working).toEqual(["b"]);
    order = settleBoardOrder(columns(["b", "a"]), order);
    expect(order.working).toEqual(["a", "b"]);
  });

  it("keeps the place of a card missing from the whole board", () => {
    const order = settleBoardOrder(columns(["a", "b"]), boardOrder());
    expect(settleBoardOrder(columns(["b"]), order).working).toEqual(["a", "b"]);
  });

  it("ignores a malformed store", () => {
    localStorage.setItem(
      "monocode.boardOrder",
      '{"working":[1,"a"],"review":3}',
    );
    expect(boardOrder()).toEqual({ working: ["a"], review: [], checked: [] });
  });
});
