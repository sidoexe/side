import type { MonoAvatar } from "../model/mono";
import { EMOJI_FONT } from "../../../shared/lib/emojiData";
import {
  PixelMascot,
  type PixelMascotStatus,
} from "../../projects/ui/PixelMascot";
import { COLLEAGUE_ICONS } from "./colleagueIcons";

type Props = {
  mascot: string;
  color: string;
  avatar?: MonoAvatar;
  status?: PixelMascotStatus;
  still?: boolean;
  className?: string;
};

/**
 * A Colleague's face: the emoji or icon it was given, on a tile of its color,
 * or its pixel mascot. Drawn in a 16-unit box like the mascot, so the same
 * size class fits both. A busy Colleague's tile breathes.
 */
export function ColleagueAvatar({
  mascot,
  color,
  avatar,
  status = "idle",
  still = false,
  className = "size-7 shrink-0",
}: Props) {
  const Glyph = avatar?.kind === "icon" ? COLLEAGUE_ICONS[avatar.value] : undefined;
  if (!avatar || (avatar.kind === "icon" && !Glyph))
    return (
      <PixelMascot
        name={mascot}
        color={color}
        status={status}
        still={still}
        className={className}
      />
    );
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      overflow="visible"
      className={`${className} ${status === "working" && !still ? "animate-pulse" : ""}`}
    >
      <rect
        x="0.5"
        y="0.5"
        width="15"
        height="15"
        rx="4.5"
        fill={color}
        fillOpacity={0.2}
        stroke={color}
        strokeOpacity={0.45}
        strokeWidth={0.6}
      />
      {avatar.kind === "emoji" ? (
        <text
          x="8"
          y="8.6"
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="10"
          style={{ fontFamily: EMOJI_FONT }}
        >
          {avatar.value}
        </text>
      ) : (
        <svg x="3" y="3" width="10" height="10" viewBox="0 0 24 24" overflow="visible">
          {Glyph ? <Glyph size={24} color={color} strokeWidth={1.9} /> : null}
        </svg>
      )}
    </svg>
  );
}
