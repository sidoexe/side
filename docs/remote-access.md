# Remote access (experimental)

sIDE can run Claude Code, Codex, Cursor, Grok Build, OpenCode, Pi, OMP, fx, Hermes Agent, Antigravity, and Devin sessions on a separate Linux or macOS host. The host owns the provider processes and session database. Closing the desktop, closing a session tab, or losing the SSH tunnel does not stop a host session.

A folder on a connected machine is a project in the rail, marked with a globe. Every session in it runs on that machine, in the same session view and composer as a local session. The Sessions sidebar lists that machine's sessions for the project. Search finds that machine's conversations too, by title and by what was said, with this computer's own.

## Connect through SSH

In **Settings → Connections → Add machine**, enter an SSH address (`user@my-mac-mini`) or an alias from your SSH config and click **Connect**. The machine picker also links to this Settings page. An optional name and SSH port are available.

sIDE downloads the host package matching the desktop release and remote architecture, verifies its checksum, installs a background service, pairs this desktop, and opens a private SSH forward. Node is included in the host package; users do not build the host, install Node, copy tokens, or run a tunnel command. Existing running hosts are reused without interrupting their agents.

Prerequisites:

- SSH must already be enabled and reachable on the host. sIDE uses the desktop's OpenSSH client and normal SSH config, keys, and agent.
- Hosts: Linux or macOS, on x64 or arm64, with `curl` or `wget`, `tar`, and `shasum` or `sha256sum`.
- Install and authenticate each provider you want to use on the host under the connecting OS account. The host must be able to find its CLI on PATH or in its standard install directory. Antigravity's ACP server is available only on macOS and Linux.
- On Linux with systemd, setup installs a systemd user service and runs `loginctl enable-linger` for the SSH account so the host survives logout. Lingering applies to all of that account's user services, and `service uninstall` leaves it enabled. If enabling it requires administrator access, Settings displays the recovery command. On Linux without systemd (many containers and microVMs, such as Firecracker), setup starts the host as a detached background process instead. It survives SSH disconnects, but nothing restarts it if it exits or the machine reboots; the next connect starts it again. macOS needs an active desktop login; keep that Mac signed in and awake.

SSH host verification and password/passphrase prompts appear in Settings. Changed host keys are rejected by OpenSSH. Passwords/passphrases are used only for the current authentication, not saved. When key/agent authentication is available, opening the remote view restores a lost tunnel automatically. If SSH needs another prompt, use **Reconnect** in Settings. Reconnecting uses the saved device credential and checks the host's identity.

The forward binds to a temporary port on the laptop's loopback interface. Quitting the desktop closes only that forward. It does not stop the host service or its agent sessions.

**Remove** in Settings asks for confirmation and offers two choices. **Remove from this desktop only** deletes the saved connection and closes its forward. The host keeps running, and this desktop's device credential stays valid on it. **Revoke access and remove** first asks the host to revoke the credential this desktop is using, then removes the connection. It needs the machine to be reachable, and if revocation fails the connection is kept. Neither option stops the host, affects other desktops' credentials, or deletes sessions. Adding the same machine again reconnects its projects, tabs, and history.

## Start a session

1. In the project rail, click **+** next to Projects and choose **Open folder on a machine…**.
2. Choose the machine, browse to an existing checkout (or type its absolute path, such as `/home/me/code/my-app`), and click **Open**.
3. Send a message. The first message creates the session on the host with the model, reasoning effort, and permission mode shown in the composer.

The composer's model picker lists models for the providers installed on the host. Model, provider-specific settings, and permission changes apply to the host session directly, and the next turn uses them; a change made during a running turn is applied when that turn finishes. If the host cannot load its model list, or no longer lists the session's model, the session's saved settings remain visible. The normal workspace and branch pickers use the host checkout through the shared file and Git commands. Choose an existing host worktree or create one from a branch before the first message; the session then runs in that working copy. Once the conversation starts, its worktree is fixed, as in a local session. Start a new session to use another worktree. The branch picker can search local and remote branches, create a local branch, and switch the current working copy when it is clean and the project's sessions are idle. Machine connection state appears on its project rail dot.

The **Explorer** sidebar and Go to File use the normal file views for host folders and files. Opening a text file uses the normal editor tabs. Saving writes back to the host; text files up to 8 MiB open in the editor and previews up to 25 MiB, as in a local project. File creation, rename, deletion, and project search use the same controls as local projects. The **Changes** sidebar and Git history graph use the normal Git views, including file diffs, staging, discarding, commits, pushing, and pull request creation through `gh` on the host. A host writes a pull request's title and body with its own agent, as for a local project; an older host, or one without an agent that can, uses the commit list and diff summary. An ordinary folder outside Git shows an empty Changes state. Git changes are refreshed every few seconds. Generated commit messages are written on the host from its staged diff, with the first installed provider among Claude, Cursor, Codex, Grok, OpenCode, Pi, omp and Devin.

The composer’s **+** menu supports file and image attachments, Plan mode, and saved drafts when the host advertises these capabilities. Attachments are copied to the host’s private data directory before the turn or draft is recorded; each file is limited to 20 MiB. Image previews are restored from the host when you reopen a conversation. Images an agent generates on the host (Codex) are kept with the attachments there and shown on the desktop, the phone and the web app. A draft can be sent or removed from its transcript card. Plan mode uses the host provider and produces a reviewable plan card whose Build action continues on the host with the session’s current model. Update older hosts to enable these menu actions.

`@` file mentions and file skills (`.agents/skills`, each provider's skill folders and Claude plugins, discovered on the host) work as they do locally; harnesses with a native command catalog (Pi, omp, Devin) list their own commands from the host, beside `/plan`, `/compact` and, on hosts that keep drafts, `/draft`. Terminals open on the machine, in the chosen folder: a terminal runs `ssh -t` to the same SSH target as the host tunnel, with your own SSH config, keys and agent, so it streams like a local one, and a machine reached through an alias to this computer gets a plain local shell. A machine connected by URL only has no SSH target and cannot open terminals. `/operator` works there too, with hosts that advertise `app`: the agent runs on the host, so it is given the host's own `app` CLI (`~/.side-host/bin/side-host app`), with the same actions and help as the local one. Each call goes to the host, which holds it until a desktop showing that session takes it, runs it as a local call and answers; folders are translated between the host's paths and the desktop's. As locally, calls are accepted only during a running turn of a thread where `/operator` was used, which the host remembers across restarts, and each host session has its own credential. The worktree settings page lists and deletes host worktrees with the same checks as locally; the sessions working in a deleted worktree are removed or moved to the project folder. A message typed while a turn runs is queued on the host and sent when the turn ends, even with the desktop closed; stopping a turn pauses the queue, and a queued message can be edited, removed or steered into the running turn. Editing the last message rewinds Codex, OpenCode, Pi and omp on the host before resending. The review card after each turn lists the files the turn changed, from Git snapshots the host takes before and after the turn, and can undo or keep them. Plans from the transcript open normal read-only plan tabs. Source files stay on the host; this feature shares host-owned sessions, not working-directory synchronization.

## Manual connection (advanced / development)

Use Node.js 24 or newer on the host. Install and sign in to the providers you want under the same OS account that runs the host. The host uses that account's default provider credentials and searches its PATH and common per-user and system installation directories.

From a checkout of this version of sIDE on the host:

```sh
npm ci
npm run host:build
node build/host/side-host.mjs start
node build/host/side-host.mjs pair --name "My laptop"
```

`start` launches the host independently of the terminal. `pair` prints a device ID and a device token; copy the token to the receiving desktop. Create a separate credential for each desktop. Tokens grant control of the host as its OS user, including provider execution and workspace reads.

The host binds only to `127.0.0.1:3775`. State and logs live in `~/.side-host`. Unix permissions restrict access to the owner. Use `--data-dir` and `--port` to override them. `serve` runs in the foreground for debugging.

Open an SSH tunnel from your laptop:

```sh
ssh -N -L 3775:127.0.0.1:3775 user@your-host
```

Under **Settings → Connections → Connect to an existing host by URL**, enter `http://127.0.0.1:3775` and the device token.

When the laptop wakes, restore the SSH tunnel. The remote view reconnects automatically and loads the host's latest persisted snapshot. An uncertain request retains its original command ID, including creation of a new session and its first message. **Retry** asks the host for that same command’s receipt, so a lost response does not create another conversation or submit the prompt again. Pending requests survive restarting the desktop and belong to the tab that created them.

HTTPS endpoints can also be entered if you operate a reverse proxy to the loopback host. Plain HTTP is accepted only for loopback endpoints. Native desktop HTTP carries the saved credential; it is not exposed to the renderer or browser storage. The native connection store is `remote-machines.json` in the desktop app's data directory, with mode 0600 on Unix. This initial implementation does not use the OS keychain.

## Provider accounts and balancing

A host can run sessions on several provider logins. Declare them in `config.json` in the host's data directory (`~/.side-host/config.json`); the file is read on every use, so no restart is needed:

```json
{
  "accounts": [
    { "id": "perso-1", "provider": "claude", "label": "Perso 1", "configDir": "~/.claude-1" },
    { "id": "perso-2", "provider": "claude", "label": "Perso 2", "configDir": "~/.claude-2" }
  ],
  "balance": ["perso-1", "perso-2"],
  "binaries": { "claude": "/opt/homebrew/bin/claude" }
}
```

Each account is a CLI profile directory the host user already signed in to (`CLAUDE_CONFIG_DIR` for Claude, `CODEX_HOME` for Codex). The remote composer shows an **Account** picker when the host lists accounts. A Claude profile already signed in under the host's home folder (`~/.claude-<name>`) but not declared is listed in that picker under **Signed in on the host**; **Import** declares it and adds it to `balance`, without signing in again. A profile signed in to an address an account already has is not offered: it is a copy of that account.

With two or more accounts in `balance`, the picker also offers **Balanced**, the default for new sessions. A balanced conversation starts on the account with the most weekly headroom; the five-hour window only rules out an account that is nearly full. When its account hits a Claude usage limit, the host carries the conversation to the next account and runs the refused turn again there, without showing the refusal. Only when every pooled account is limited does the usual limit notice appear. Window levels are recorded in `account-usage.json` next to `config.json`. Each account's row in the picker has a **Balanced** chip that adds it to `balance` or takes it out, and a reconnect button that signs that account in again.

The limit notice works on host sessions: **Resume** continues the conversation, **Dismiss** clears the notice, and **Resume at reset** is kept by the host, which continues the conversation itself once the window reopens, with every desktop closed.

`binaries` overrides where the host finds a provider CLI; otherwise its PATH decides.

## Where projects open

Projects open where you choose them: **Open folder…** opens a folder of this computer, **Open folder on a machine…** a folder of a connected machine. Nothing moves between the two. A session on a machine runs on that machine's accounts. Automations stay on each computer.

## Open the host in a browser

The host serves the phone app at `/web`, for a phone's browser or any other: the same screens as the iPhone app, in a page. It covers what you do there with a host's sessions:

- **Now**: what waits on you across every project (To review, with a Checked button on a done session), what is working, and what this browser checked; the tab's badge counts what waits on you;
- **Projects**: the desktop's projects, folded to their counts, with a filter, new sessions, and **Open folder** to open a folder of the host;
- live transcripts, sending, queuing, steering and stopping, approvals and questions, editing the last message, Plan mode and Build, photo and file attachments, context usage, and a usage-limit notice that resumes at reset;
- model, effort, permissions and account chips, in a new session and in an open one;
- rename, pin, archive, delete and mark checked, from a session's **…** menu or a long press on its row;
- the host's accounts and their usage, signing one in again or adding one, under **… → Usage & accounts**; the desktop's web apps, which open in a tab of their own;
- notifications when a session needs you or finishes (**… → Notifications**; on iPhone, add the page to the Home Screen first).

1. Create a credential for the browser on the host: `~/.side-host/bin/side-host pair --name "Web"`.
2. Publish only `/web` on your tailnet (HTTPS, reachable from your devices only):

   ```sh
   tailscale serve --bg --set-path /web http://127.0.0.1:3775/web
   ```

3. Open `https://<machine>.<tailnet>.ts.net/web/` and paste the token. On iPhone, **Share → Add to Home Screen** opens it full screen.

The token is kept in an `HttpOnly`, `SameSite=Strict` cookie scoped to `/web` for 30 days. `/web/rpc` answers only requests from the page's own origin; the desktop endpoint `/rpc` still refuses every browser. **Sign out** clears the cookie; `side-host revoke DEVICE_ID` ends access everywhere. Like any device token, it controls the host as its OS user: do not publish `/web` with `tailscale funnel` or another public tunnel.

On the host machine itself, `http://127.0.0.1:3775/web/` works without Tailscale.

### Several machines

Every machine runs its own host, and its sessions run there. The phone app and the web app show the sessions of every machine together: **Now** and **Projects** list them all, with the machine's name where a list mixes machines, and **Projects** groups projects by machine.

- In the web app, **… → Machines → Add machine** takes another machine's pairing link (`side-host pair --name Web --url <its address>`) or its address and a device credential. The host that serves the page keeps that credential (in `machines.json`, readable by its user only) and passes the page's calls on to the machine; the page never holds it. Notifications come from every machine.
- In the phone app, **… → Machines → Add machine** pairs another machine the same way; the phone talks to each one directly, and each one sends its notifications.

**Rename** shows a machine under another name, for two Macs with the same host name. **Remove** stops showing it; its sessions keep running on it.

### Deploy the web app with each release

A host serves the web app its package came with. A host the desktop does not update (connected by URL rather than SSH) can still get each release's web app as soon as the release is published: the `deploy-web` job of the release workflow joins the tailnet and asks the host to install it. The host downloads that release's own package from GitHub, checks it against the published checksum, and swaps in its `web` folder without restarting; the one it replaces stays as `web.previous`. The deploy key opens only this: it cannot read sessions or run anything, and it can only install the web app of an official release.

1. On the host, issue the key (shown once; issuing another replaces it, `--revoke` removes it): `~/.side-host/bin/side-host deploy-key`.
2. In Tailscale, create a tag `tag:ci`, allow it to reach only that machine on port 443, and create an OAuth client that can create auth keys for `tag:ci`.
3. In the GitHub repository, add the secrets `SIDE_WEB_DEPLOY_KEY` (the key), `TS_OAUTH_CLIENT_ID` and `TS_OAUTH_SECRET`, and the variable `SIDE_WEB_DEPLOY_URL` (`https://<machine>.<tailnet>.ts.net`). The job is skipped while the variable is unset.

The host needs a release that has `deploy-key`. By hand, `npm run web:deploy` in a checkout builds the web app and puts it on the host installed in `~/.side-host` the same way.

## Preview a machine's local web servers

When an agent on a host starts a dev server and links to it (`http://localhost:5173`), clicking the link opens the page in the **Web view**, served by that machine. The host publishes the port on its tailnet with `tailscale serve --https=<port>`, so the page lives at `https://<machine>.<tailnet>.ts.net:<port>`, and a web app named after the machine and port keeps it in the rail, synced to your other devices. Opening the link again points that app at the new page.

Every published port goes to one proxy on the host, at its port + 1 (`127.0.0.1:3776` by default), which forwards to `localhost:<port>` with `localhost` as the host name. Dev servers that only answer their own name, such as Vite, need no extra setting, and their hot reload WebSocket works through it.

Access is limited to the tailnet, and the proxy also asks for a token: the link carries it once, and the proxy trades it for a cookie. The browser app's credential is never forwarded to the dev server. Ports from 1024 to 65535 can be previewed. A published port stays published, for the links it gave out; `tailscale serve --https=<port> off` on the host removes one.

Previews need the `tailscale` CLI on the host, signed in; on Linux, `tailscale serve` also needs `sudo tailscale set --operator=$USER` once. Without Tailscale, `localhost` links open in the browser as before.

## Manage the host

```sh
node build/host/side-host.mjs status
node build/host/side-host.mjs devices
node build/host/side-host.mjs revoke DEVICE_ID
node build/host/side-host.mjs stop
node build/host/side-host.mjs service uninstall
```

SSH setup names each device credential after the desktop's computer name. Removing a saved connection from the desktop does not stop the host. It revokes the device credential only when you choose **Revoke access and remove**. Otherwise, use `devices` and `revoke` on the host to remove access. Stopping the host interrupts active turns; restarting retains their transcripts and marks them interrupted. No uncertain provider operation is automatically replayed after a host crash.

`service uninstall` is the cleanup path for a host you no longer want running. It removes the systemd user service or the LaunchAgent. It then stops the host, including a manually started one, and interrupts any running turns. It never deletes the data directory. Sessions, logs, and device credentials stay in `~/.side-host` until you delete that directory yourself. To remove access without stopping the host, use `revoke` instead. On Linux, the command prints how to turn off lingering if nothing else needs it.

The machine must remain awake. Manual `start` launches a detached process. `service install` installs a user service; SSH setup runs it automatically. Only one host may own a data directory. Restart the host after changing its provider installation or PATH. Service installs preserve an already-running host, including one previously started manually.

SSH-installed hosts have a launcher at `~/.side-host/bin/side-host`; use it in place of `node build/host/side-host.mjs` in management commands. Linux services are named `side-host.service`; macOS uses `dev.sidoexe.side.host`. A service manager can restart a stopped process, so use `service uninstall` rather than `stop` to keep the host stopped.

## Release packaging

`npm run host:package` builds a self-contained package for the current Mac/Linux architecture. `npm run host:package -- --all` builds all four archives, using pinned official Node binaries and checksums. Archives contain the host bundle, runtime, launcher, and licenses. `host/package.mjs` pins the runtime version.

The release workflow publishes `side-host-darwin-arm64.tar.gz` and its `.sha256` file alongside the desktop release. SSH setup downloads from the exact desktop version's GitHub release, then installs under `~/.side-host/runtime`.

**Unreleased development builds:** automatic first-time installation and **Update Host** require host archives published for the desktop version. Release builds from v0.5.0 onward include the matching archives; an unreleased checkout may not have them. Until the matching release is available, use the manual development connection above. A missing archive produces an explicit error in Settings. No fallback to an arbitrary latest release or unverified download is used. Connecting alone does not upgrade a running host. When an SSH host is older than the desktop, Settings → Connections offers **Update Host**. This downloads and verifies the matching package, restarts the host service, and reconnects using the existing device credential. The restart interrupts active agent turns; sessions and history remain on the host. URL connections must be updated on the host manually. sIDE also updates an SSH host by itself when the host is older than the desktop: at launch and every five minutes it checks each machine, and once no turn runs there it installs the desktop's release as **Update Host** does. A host that needs a password or passphrase, or whose update fails, is left to **Update Host** in Settings until the next launch.

## Scope of this first version

Supported: persistent remote text conversations with all ten local provider adapters, follow-up turns, approvals, questions where the provider offers them, cancellation, per-device revocation, reconnect, remote file browsing and text editing, Git status, file diffs, and history, staging and commits, branch selection and creation, worktree selection and creation, and a tracked Git diff against HEAD. OpenCode's server and event stream stay on the host's loopback interface. Cursor's optional enrichment from its native session database is not available on the headless host; basic transcript and subagent events still work. The desktop polls the host and downloads only transcript blocks that changed since its last update (every 0.75 s while a session runs, 3 s otherwise). The desktop rejects any single host response over 16 MiB. A sync above 4 MiB, such as reopening a very long transcript or one very large tool output, is sent as a series of bounded pieces of one consistent revision. Transcript size is therefore not limited by the response cap. The host writes streamed output in 120 ms batches and keeps a bounded event journal.

Remote history appears in the Sessions sidebar of each project on a machine. Host snapshots also populate the app's normal session state while the tab is open; they are not written to the local session store. Remote `/compact` uses the provider's context compaction, and `/plan` selects the host provider's plan mode. Skill bodies and `@` references are expanded on the desktop and sent as the send command's `prompt`, so the transcript keeps what was typed. Generated image output, orchestration, LAN discovery, and account-based tunnels are not implemented yet. Other remote prompts are sent directly to the provider.

The headless host runs the reused TypeScript adapters with a Node process backend. It proves the execution boundary without introducing the planned Rust daemon/worker IPC yet. Node is included in host release archives, separately from the desktop application.

## Verify

```sh
npm run host:build
npm run test:host
npm run check:web
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test
```

Host tests use fake provider executables and temporary loopback servers. They do not contact paid models. They cover the Codex and Claude transports, Pi/OMP RPC, ACP providers, OpenCode HTTP and event streaming, cross-client reattachment, duplicate sends, approval races, interruption recovery, device revocation, path checks, and detached host lifecycle. On Node 26, use `NODE_OPTIONS=--no-experimental-webstorage npm run check:web` to avoid its experimental global storage interfering with the existing happy-dom tests.

For the real OpenSSH transport and native askpass smoke test on Linux/macOS, build with `npm run host:package` and `cargo build --bin monocode`, then run `python3 scripts/test-remote-ssh.py`. It uses a disposable loopback sshd, temporary keys and known-hosts file, and an isolated packaged host. It leaves personal SSH configuration, provider credentials, and OS services untouched.

Host CI runs on macOS.
