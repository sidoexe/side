import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { login } from "./api";
import { HostAccountsSheet } from "./accounts";
import { NowView, ProjectsView, UsageSheet } from "./home";
import { FolderBrowserView, NewSessionView } from "./newSession";
import { SessionView } from "./session";
import { model, useModel, type HomeTab, type Route } from "./store";
import { DialogHost, Icon, Sheet, Spinner, usePoll } from "./ui";
import "./styles.css";

/** The phone app (ios/SideMobile) in a browser: the host's sessions in two
 * tabs, Now and Projects, each with its own stack of screens. */
function Root() {
  const app = useModel();
  // The host, its projects and their sessions, every 5 seconds.
  usePoll(() => (app.state.signedIn === false ? undefined : app.refresh()), () => 5000, [app.state.signedIn === false]);
  if (app.state.signedIn === false) return <ConnectView />;
  if (!app.state.host)
    return (
      <div className="screen loading">
        <Spinner />
      </div>
    );
  return (
    <>
      <div className="tabs">
        <TabStack tab="now" />
        <TabStack tab="projects" />
      </div>
      <TabBar />
      <SheetHost />
      <DialogHost />
    </>
  );
}

/** One tab's own stack, so switching tabs keeps where each one was. Its
 * root stays mounted under the screens pushed over it, with its scroll. */
function TabStack({ tab }: { tab: HomeTab }) {
  const app = useModel();
  const path = app.state.paths[tab];
  const top = path.at(-1);
  return (
    <div className="tab" hidden={app.state.tab !== tab}>
      <div className="stack-root" hidden={!!top}>
        {tab === "now" ? <NowView /> : <ProjectsView />}
      </div>
      {top ? (
        <div className="stack-top" key={key(top)}>
          <Screen route={top} />
        </div>
      ) : null}
    </div>
  );
}

const key = (route: Route) =>
  route.kind === "session" ? `s:${route.sessionId}` : route.kind === "new" ? `n:${route.projectId}` : route.kind;

function Screen({ route }: { route: Route }) {
  switch (route.kind) {
    case "session":
      return <SessionView projectId={route.projectId} sessionId={route.sessionId} />;
    case "new":
      return <NewSessionView projectId={route.projectId} />;
    case "browse":
      return <FolderBrowserView />;
  }
}

function TabBar() {
  const app = useModel();
  const waiting = app.toReview().length;
  const tabs: { id: HomeTab; label: string; icon: string; badge?: number }[] = [
    { id: "now", label: "Now", icon: "tray", badge: waiting },
    { id: "projects", label: "Projects", icon: "folder" },
  ];
  return (
    <nav className="tab-bar">
      {tabs.map((tab) => (
        <button key={tab.id} className={`tab-button${app.state.tab === tab.id ? " on" : ""}`} onClick={() => app.selectTab(tab.id)}>
          <span className="tab-icon">
            <Icon name={tab.icon} size={24} />
            {tab.badge ? <span className="badge">{tab.badge}</span> : null}
          </span>
          <span>{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}

function SheetHost() {
  const app = useModel();
  const sheet = app.state.sheet;
  if (!sheet) return null;
  const close = () => app.set({ sheet: undefined });
  return (
    <Sheet onClose={close}>
      {sheet.kind === "usage" ? <UsageSheet /> : <HostAccountsSheet provider={sheet.provider} onDone={close} />}
    </Sheet>
  );
}

/** Pairing: paste the host's link, or a credential from
 * `side-host pair --name <device>`. The address is this page's. */
function ConnectView() {
  const [token, setToken] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [failure, setFailure] = useState<string>();
  const connect = async (input: string) => {
    setFailure(undefined);
    // A pairing link (`side://pair?host=…&token=…`) carries the credential.
    let credential = input.trim();
    if (credential.startsWith("side://")) credential = new URL(credential.replace(/^side:/, "https:")).searchParams.get("token") ?? "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) return setFailure("That is not a pairing link or a 43-character credential.");
    setConnecting(true);
    try {
      await login(credential);
      await model.refresh();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setConnecting(false);
    }
  };
  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) await connect(text);
    } catch {
      setFailure("The browser did not share the clipboard. Paste the link in the field below.");
    }
  };
  return (
    <div className="screen connect">
      <header className="large-title">Connect to a host</header>
      <div className="scroll">
        <div className="form-section">
          <div className="form-group">
            <button className="form-row link" onClick={() => void paste()}>
              <Icon name="copy" size={17} />
              Paste
            </button>
          </div>
          <div className="form-footer">
            On the host, run <code>side-host pair --name iPhone --url {location.origin}</code> and copy the link.
          </div>
        </div>
        <form
          className="form-section"
          onSubmit={(event) => {
            event.preventDefault();
            void connect(token);
          }}
        >
          <div className="form-header">Or enter it</div>
          <div className="form-group">
            <input className="form-row" value={location.host} readOnly aria-label="Host address" />
            <input
              className="form-row"
              type="password"
              value={token}
              placeholder="Device credential"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => setToken(event.target.value)}
            />
          </div>
          {failure ? <div className="form-footer del">{failure}</div> : null}
          <div className="form-group spaced">
            <button className="form-row link between" disabled={connecting || !token}>
              Connect
              {connecting ? <Spinner size={16} /> : null}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** The keyboard covers the tab bar, as on iOS. */
function useKeyboardClass() {
  useEffect(() => {
    const typing = () => {
      const element = document.activeElement;
      document.body.classList.toggle(
        "typing",
        element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && !["checkbox", "radio", "button"].includes(element.type)),
      );
    };
    addEventListener("focusin", typing);
    addEventListener("focusout", () => setTimeout(typing));
    return () => removeEventListener("focusin", typing);
  }, []);
}

function App() {
  useKeyboardClass();
  return <Root />;
}

// Notifications open their session; register the worker that shows them.
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/web/sw.js", { scope: "/web/" }).catch(() => undefined);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
