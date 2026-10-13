import type { MonoAvatar, MonoStatus } from "../model/mono";
import { ColleagueAvatar } from "./ColleagueAvatar";

/** The rail mascot and its status circle, shared by both rail layouts. */
export function MonoRailMascot({
  name,
  color,
  avatar,
  status = "idle",
  className = "size-4 shrink-0",
}: {
  name: string;
  color: string;
  avatar?: MonoAvatar;
  status?: MonoStatus;
  className?: string;
}) {
  return (
    <span className={`relative grid place-items-center ${className}`}>
      <ColleagueAvatar
        mascot={name}
        color={color}
        avatar={avatar}
        status={status}
        still={status === "idle"}
        className="size-full"
      />
      <MonoStatusDot
        status={status}
        color={color}
        className="-top-0.5 -right-0.5 size-1.5"
      />
    </span>
  );
}

/** The status circle alone, for rails that dim the mascot but not its state. */
export function MonoStatusDot({
  status,
  color,
  className,
}: {
  status: MonoStatus;
  color: string;
  className: string;
}) {
  return (
    <span
      aria-hidden
      className={`absolute rounded-full ring-1 ring-background-base ${className} ${
        status === "working"
          ? "motion-safe:animate-pulse"
          : status === "needs-you"
            ? "bg-accent"
            : "bg-content/30"
      }`}
      style={status === "working" ? { backgroundColor: color } : undefined}
    />
  );
}
