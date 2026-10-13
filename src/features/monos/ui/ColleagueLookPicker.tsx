import { lazy, Suspense, useRef, useState } from "react";
import { EMOJI_FONT } from "../../../shared/lib/emojiData";
import {
  saveMonoAvatar,
  saveMonoMascot,
  updateMono,
  type MonoLook,
} from "../model/mono";
import { COLLEAGUE_ICONS, COLLEAGUE_ICON_NAMES } from "./colleagueIcons";
import { ColorPicker, MascotPicker } from "./monoPanelParts";

const EmojiPickerPopover = lazy(() =>
  import("../../../shared/ui/EmojiPicker").then((module) => ({
    default: module.EmojiPickerPopover,
  })),
);

/** A first handful, so most picks take one click; the full picker is a click further. */
const QUICK_EMOJI = [
  "🤖", "🧠", "🦊", "🐙", "🦉", "🐝", "🐳", "🦄", "🐼", "🐸",
  "🚀", "⚡", "🔥", "✨", "🌱", "🍀", "☕", "🎯", "🎨", "🎧",
  "📚", "🧪", "🛠️", "🔍", "📈", "💡", "🧭", "🛡️", "👾", "😎",
];

type Face = "mascot" | "emoji" | "icon";

const FACES: { id: Face; label: string }[] = [
  { id: "mascot", label: "Mascot" },
  { id: "emoji", label: "Emoji" },
  { id: "icon", label: "Icon" },
];

/**
 * Everything about how a Colleague looks: a mascot, an emoji or an icon,
 * and its color, which tints whichever face it wears.
 */
export function ColleagueLookPicker({
  monoId,
  look,
  columns = 10,
}: {
  monoId: string;
  look: MonoLook;
  columns?: 5 | 10;
}) {
  const [face, setFace] = useState<Face>(look.avatar?.kind ?? "mascot");
  const [moreEmoji, setMoreEmoji] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const large = columns === 5;
  const cell = `grid min-w-0 place-items-center ${large ? "h-11 rounded-lg" : "h-8 rounded-md"}`;
  const selected = (on: boolean) =>
    on ? "bg-selection ring-1 ring-content/20" : "hover:bg-content/6";
  const grid = `grid gap-1 px-1 ${large ? "grid-cols-5" : "grid-cols-10"}`;

  return (
    <div className="flex flex-col gap-2">
      <div
        role="tablist"
        aria-label="Face"
        className="mx-1 grid grid-cols-3 gap-0.5 rounded-md bg-content/6 p-0.5"
      >
        {FACES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={face === id}
            onClick={() => setFace(id)}
            className={`rounded-[5px] px-2 py-1 text-[12px] ${
              face === id
                ? "bg-content/12 text-content"
                : "text-content/60 hover:text-content"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {face === "mascot" ? (
        <MascotPicker
          columns={columns}
          current={look.avatar ? "" : look.mascot}
          color={look.color}
          onPick={(mascot) => saveMonoMascot(monoId, mascot)}
        />
      ) : null}

      {face === "emoji" ? (
        <div className="flex flex-col gap-1">
          <div role="radiogroup" aria-label="Emoji" className={grid}>
            {QUICK_EMOJI.map((emoji) => {
              const on = look.avatar?.kind === "emoji" && look.avatar.value === emoji;
              return (
                <button
                  key={emoji}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={emoji}
                  onClick={() => saveMonoAvatar(monoId, { kind: "emoji", value: emoji })}
                  className={`${cell} ${selected(on)} ${large ? "text-[22px]" : "text-[17px]"} leading-none`}
                  style={{ fontFamily: EMOJI_FONT }}
                >
                  {emoji}
                </button>
              );
            })}
          </div>
          <button
            ref={more}
            type="button"
            onClick={() => setMoreEmoji(true)}
            className="mx-1 rounded-md px-2 py-1 text-left text-[12px] text-content/60 hover:bg-content/6 hover:text-content"
          >
            More emoji…
          </button>
          {moreEmoji ? (
            <Suspense fallback={null}>
              <EmojiPickerPopover
                anchor={more}
                onPick={(emoji) => {
                  saveMonoAvatar(monoId, { kind: "emoji", value: emoji });
                  setMoreEmoji(false);
                }}
                onDismiss={() => setMoreEmoji(false)}
              />
            </Suspense>
          ) : null}
        </div>
      ) : null}

      {face === "icon" ? (
        <div
          role="radiogroup"
          aria-label="Icon"
          className={`${grid} max-h-56 overflow-y-auto`}
        >
          {COLLEAGUE_ICON_NAMES.map((name) => {
            const Glyph = COLLEAGUE_ICONS[name];
            const on = look.avatar?.kind === "icon" && look.avatar.value === name;
            return (
              <button
                key={name}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={name}
                title={name.replace(/\d+$/, "").replace(/([a-z])([A-Z])/g, "$1 $2")}
                onClick={() => saveMonoAvatar(monoId, { kind: "icon", value: name })}
                className={`${cell} ${selected(on)}`}
              >
                <Glyph
                  size={large ? 22 : 17}
                  color={look.color}
                  strokeWidth={1.9}
                />
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="h-px bg-content/10" />
      <ColorPicker
        inline
        columns={columns}
        current={look.color}
        onPick={(color) => updateMono(monoId, (mono) => ({ ...mono, color }))}
      />
    </div>
  );
}
