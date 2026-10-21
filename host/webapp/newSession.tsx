import { useEffect, useState } from "react";
import { command, rpc } from "./api";
import { folderName, HARNESS_TITLES, RUNTIME_MODES, tilde, type HostDirectory, type HostModelCatalog } from "./model";
import { useModel } from "./store";
import { Chip, Composer, type Outgoing } from "./composer";
import { HarnessIcon, Icon, Mascot, NavBar, Spinner, type MenuItem } from "./ui";

const remembered = (key: string, fallback: string) => localStorage.getItem(key) ?? fallback;

/** The IDE's empty session: the project's name over a composer whose chips
 * pick the project, agent and model, permissions and account. */
export function NewSessionView({ projectId }: { projectId: string }) {
  const model = useModel();
  const [current, setCurrent] = useState(projectId);
  const [harness, setHarnessState] = useState(() => remembered("new.harness", "claude"));
  const [modelId, setModelState] = useState(() => remembered("new.model", ""));
  const [mode, setModeState] = useState(() => remembered("new.mode", "supervised"));
  const [account, setAccount] = useState("");
  const [catalog, setCatalog] = useState<HostModelCatalog>();
  const project = model.project(current);
  const harnesses = (model.state.host?.providers ?? []).filter((provider) => catalog?.models[provider]?.length);
  const selected = catalog?.models[harness]?.find((item) => item.id === modelId);
  const accounts = model.state.accounts.filter((item) => item.provider === harness);

  const setHarness = (value: string) => {
    localStorage.setItem("new.harness", value);
    setHarnessState(value);
  };
  const setModel = (value: string) => {
    localStorage.setItem("new.model", value);
    setModelState(value);
  };
  const setMode = (value: string) => {
    localStorage.setItem("new.mode", value);
    setModeState(value);
  };

  useEffect(() => {
    if (!project) return;
    let live = true;
    rpc<HostModelCatalog>("models.list", { projectId: project.id }).then(
      (loaded) => {
        if (!live) return;
        setCatalog(loaded);
        const available = (model.state.host?.providers ?? []).filter((provider) => loaded.models[provider]?.length);
        const nextHarness = available.includes(harness) ? harness : available.includes("claude") ? "claude" : (available[0] ?? harness);
        if (nextHarness !== harness) setHarness(nextHarness);
        const models = loaded.models[nextHarness] ?? [];
        if (!models.some((item) => item.id === modelId)) setModel(models[0]?.id ?? "");
        const own = model.state.accounts.filter((item) => item.provider === nextHarness);
        if (!own.some((item) => item.id === account)) setAccount(own.find((item) => item.pool)?.id ?? "");
      },
      (error: unknown) => live && model.report(error),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  const create = async (outgoing: Outgoing) => {
    if (!project || !modelId) return;
    try {
      const receipt = await command({
        type: "create",
        projectId: project.id,
        harness,
        model: modelId,
        runtimeMode: mode,
        ...(account ? { providerAccountId: account } : {}),
      });
      await command({
        type: "send",
        sessionId: receipt.sessionId,
        text: outgoing.text,
        ...(outgoing.attachments.length ? { attachments: outgoing.attachments } : {}),
        ...(outgoing.plan ? { intent: "plan" } : {}),
      });
      await model.refresh();
      // The new session replaces this screen, as on the desktop.
      model.replace({ kind: "session", projectId: project.id, sessionId: receipt.sessionId });
    } catch (error) {
      model.report(error);
      throw error;
    }
  };

  const projects = model.visibleProjects();
  const modelItems = (): MenuItem[] =>
    harnesses.flatMap((provider): MenuItem[] => [
      { kind: "section", label: HARNESS_TITLES[provider] ?? provider },
      ...(catalog?.models[provider] ?? []).map(
        (item): MenuItem => ({
          label: item.name,
          checked: provider === harness && item.id === modelId,
          run: () => {
            setHarness(provider);
            setModel(item.id);
            setAccount("");
          },
        }),
      ),
    ]);

  return (
    <div className="screen">
      <NavBar back={() => model.pop()} title="New session" />
      <div className="new-session">
        <div className="grow-1" />
        {project ? (
          <div className="new-title">
            <Mascot seed={folderName(project.cwd)} size={18} />
            <span className="ellipsis">{project.name}</span>
          </div>
        ) : null}
        <Composer
          disabled={!selected}
          canPlan={model.can("sessions.plan")}
          onSend={create}
          context={project ? <span className="mono ellipsis rtl"><bdi>{tilde(project.cwd)}</bdi></span> : null}
          tools={
            <>
              {projects.length > 1 && project ? (
                <Chip
                  icon={<Mascot seed={folderName(project.cwd)} size={11} />}
                  label={project.name}
                  items={projects.map((item) => ({ label: item.name, checked: item.id === project.id, run: () => setCurrent(item.id) }))}
                />
              ) : null}
              <Chip
                icon={<HarnessIcon harness={harness} size={13} />}
                label={selected?.name ?? (catalog ? "No models" : "Loading…")}
                disabled={!harnesses.length}
                items={modelItems}
              />
              <Chip
                label={RUNTIME_MODES.find((item) => item.id === mode)?.label ?? mode}
                items={RUNTIME_MODES.map((item) => ({ label: item.label, checked: item.id === mode, run: () => setMode(item.id) }))}
              />
              {accounts.length ? (
                <Chip
                  label={accounts.find((item) => item.id === account)?.label ?? "Default"}
                  items={[
                    { label: "Default", checked: !account, run: () => setAccount("") },
                    ...accounts.map((item): MenuItem => ({ label: item.label, checked: item.id === account, run: () => setAccount(item.id) })),
                  ]}
                />
              ) : null}
            </>
          }
        />
        {catalog?.errors[harness] ? <div className="meta del pad-x">{catalog.errors[harness]}</div> : null}
        <div className="grow-2" />
      </div>
    </div>
  );
}

/** Picks a folder of the host and opens it as a project. */
export function FolderBrowserView() {
  const model = useModel();
  const [directory, setDirectory] = useState<HostDirectory>();
  const [opening, setOpening] = useState(false);
  const load = (path?: string) =>
    rpc<HostDirectory>("projects.browse", path ? { path } : {}).then(setDirectory, (error: unknown) => model.report(error));
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="screen">
      <NavBar
        back={() => model.pop()}
        title="Open folder"
        trailing={
          <button
            className="bar-text strong"
            disabled={!directory || opening}
            onClick={async () => {
              if (!directory) return;
              setOpening(true);
              const project = await model.openProject(directory.path);
              setOpening(false);
              if (project) model.reset([{ kind: "new", projectId: project.id }]);
            }}
          >
            Open
          </button>
        }
      />
      <div className="scroll">
        {directory ? (
          <div className="list-section">
            <div className="list-header mono">{tilde(directory.path)}</div>
            <div className="list">
              {directory.parent ? (
                <button className="list-row muted" onClick={() => void load(directory.parent!)}>
                  <Icon name="parent" size={15} />
                  <span>..</span>
                </button>
              ) : null}
              {directory.entries.map((entry) => (
                <button key={entry.path} className={`list-row${entry.name.startsWith(".") ? " muted" : ""}`} onClick={() => void load(entry.path)}>
                  <Mascot seed={entry.name} size={12} />
                  <span className="ellipsis">{entry.name}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="loading">
            <Spinner />
          </div>
        )}
      </div>
    </div>
  );
}
