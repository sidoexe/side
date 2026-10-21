/**
 * The order the user gave the board's cards, one list per column. A card new
 * to a column goes on top; one dragged within it keeps its place. A card that
 * moves to another column leaves this one's list, so coming back puts it on
 * top again. One missing from the whole board, a host's not listed yet for
 * instance, keeps its place.
 */

export type BoardColumn = "working" | "review" | "checked";
export type BoardOrder = Readonly<Record<BoardColumn, readonly string[]>>;

const KEY = "monocode.boardOrder";
const CHANGED = "monocode:board-order-changed";
const COLUMNS: readonly BoardColumn[] = ["working", "review", "checked"];
const LIMIT = 200;
const EMPTY: BoardOrder = { working: [], review: [], checked: [] };

let cache: { raw: string | null; value: BoardOrder } | null = null;

function readRaw(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function parse(raw: string | null): BoardOrder {
  try {
    const parsed: unknown = JSON.parse(raw ?? "");
    if (!parsed || typeof parsed !== "object") return EMPTY;
    const stored = parsed as Record<string, unknown>;
    const ids = (value: unknown) =>
      Array.isArray(value)
        ? value.filter((id): id is string => typeof id === "string")
        : [];
    return {
      working: ids(stored.working),
      review: ids(stored.review),
      checked: ids(stored.checked),
    };
  } catch {
    return EMPTY;
  }
}

/** Stable while nothing changes. */
export function boardOrder(): BoardOrder {
  const raw = readRaw();
  if (cache?.raw !== raw) cache = { raw, value: parse(raw) };
  return cache.value;
}

export function subscribeBoardOrder(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) onChange();
  };
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function saveBoardOrder(next: BoardOrder) {
  const raw = JSON.stringify(next);
  if (raw === readRaw()) return;
  cache = { raw, value: next };
  try {
    localStorage.setItem(KEY, raw);
  } catch {
    // private mode / quota
  }
  window.dispatchEvent(new Event(CHANGED));
}

/**
 * The remembered order once the board shows `columns`: cards new to a column
 * on top, in the order given, and cards gone to another column dropped.
 */
export function settleBoardOrder(
  columns: Readonly<Record<BoardColumn, readonly string[]>>,
  saved: BoardOrder,
): BoardOrder {
  const next = { ...EMPTY };
  for (const column of COLUMNS) {
    const known = new Set(saved[column]);
    const elsewhere = new Set(
      COLUMNS.flatMap((other) => (other === column ? [] : columns[other])),
    );
    const here = new Set(columns[column]);
    next[column] = [
      ...columns[column].filter((id) => !known.has(id)),
      ...saved[column].filter((id) => here.has(id) || !elsewhere.has(id)),
    ].slice(0, LIMIT);
  }
  return next;
}

/** `items` in the remembered order for their column. */
export function arrangeColumn<T extends { id: string }>(
  items: readonly T[],
  order: readonly string[],
): T[] {
  const rank = new Map(order.map((id, index) => [id, index]));
  // New ones the order does not know yet sit on top, as settling puts them.
  return [...items].sort(
    (a, b) => (rank.get(a.id) ?? -1) - (rank.get(b.id) ?? -1),
  );
}

/** The user dragged a card within `column`, which now reads `ids`. */
export function reorderBoardColumn(column: BoardColumn, ids: string[]) {
  const saved = boardOrder();
  const shown = new Set(ids);
  saveBoardOrder({
    ...saved,
    [column]: [...ids, ...saved[column].filter((id) => !shown.has(id))],
  });
}
