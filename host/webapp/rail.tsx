import { useState } from "react";
import type { HostProject } from "../../src/features/connections/model/protocol";
import { ProjectMascot } from "../../src/features/projects/ui/ProjectMascot";
import { tabGroupColor } from "../../src/features/workspace/model/tabGroups";
import { projectName } from "../../src/shared/lib/paths";
import type { HostRailState } from "../rail";
import { rpc } from "./api";

export type { HostRailState };

/** The projects to list: the rail's, in its order, when the desktop sent one;
 * otherwise every project of the host but the archived ones. */
export function visibleProjects(projects: HostProject[], rail?: HostRailState): HostProject[] {
  if (rail?.projects.length) {
    const byCwd = new Map(projects.map((project) => [project.cwd, project]));
    return rail.projects.flatMap((cwd) => byCwd.get(cwd) ?? []);
  }
  return projects.filter((project) => !rail?.archived.includes(project.cwd));
}

/** The desktop's look for a project: its pixel mascot in its color, both
 * drawn from the folder's name as the rail draws them. */
export function ProjectBadge({ cwd, busy }: { cwd: string; busy?: boolean }) {
  const seed = projectName(cwd);
  return (
    <span className="project-badge">
      <ProjectMascot project={seed} color={tabGroupColor(seed)} className="mascot" active={busy} />
    </span>
  );
}

export const backgroundUrl = (cwd: string, rail?: HostRailState) =>
  rail?.backgrounds[cwd] ? `/web/background?cwd=${encodeURIComponent(cwd)}&v=${rail.backgrounds[cwd]}` : undefined;

/** A project's background image behind its sessions, faint as on the desktop. */
export function ProjectBackground({ url }: { url?: string }) {
  return url ? <div className="project-background" style={{ backgroundImage: `url("${url}")` }} aria-hidden /> : null;
}

const readImage = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error(`Cannot read ${file.name}`));
    reader.readAsDataURL(file);
  });

/** A project's menu in the sidebar: its background, and taking it off the list. */
export function ProjectMenu({
  project,
  rail,
  projects,
  onRail,
  onError,
}: {
  project: HostProject;
  rail?: HostRailState;
  projects: HostProject[];
  onRail: (rail: HostRailState) => void;
  onError: (error: unknown) => void;
}) {
  const [open, setOpen] = useState(false);
  const pickImage = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        onRail(await rpc<HostRailState>("projects.setBackground", { cwd: project.cwd, mimeType: file.type, data: await readImage(file) }));
      } catch (error) {
        onError(error);
      }
    };
    input.click();
  };
  const hide = () => {
    const shown = visibleProjects(projects, rail).map((item) => item.cwd);
    void rpc<HostRailState>("projects.setRail", {
      projects: shown.filter((cwd) => cwd !== project.cwd),
      archived: [project.cwd, ...(rail?.archived ?? [])],
    }).then(onRail, onError);
  };
  const actions: [string, () => void][] = [
    ["Background image…", pickImage],
    ...(rail?.backgrounds[project.cwd]
      ? ([["Remove background", () => void rpc<HostRailState>("projects.clearBackground", { cwd: project.cwd }).then(onRail, onError)]] as [string, () => void][])
      : []),
    ["Remove from list", hide],
  ];
  return (
    <span className="menu-anchor">
      <button className="icon" aria-label={`${project.name} options`} onClick={() => setOpen(!open)}>
        <svg className="glyph" viewBox="0 0 16 16" aria-hidden>
          <circle cx="3.5" cy="8" r="1.2" fill="currentColor" /><circle cx="8" cy="8" r="1.2" fill="currentColor" /><circle cx="12.5" cy="8" r="1.2" fill="currentColor" />
        </svg>
      </button>
      {open ? (
        <>
          <div className="menu-backdrop" onClick={() => setOpen(false)} />
          <div className="popover">
            {actions.map(([label, action]) => (
              <button
                key={label}
                className={label === "Remove from list" ? "danger" : ""}
                onClick={() => {
                  setOpen(false);
                  action();
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </span>
  );
}
