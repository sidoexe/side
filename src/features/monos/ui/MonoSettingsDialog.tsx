import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { isImeComposition } from "../../../shared/lib/keyboard";
import { useLockOverscroll } from "../../../shared/hooks/useLockOverscroll";
import { Modal } from "../../../shared/ui/Modal";
import { Popover } from "../../../shared/ui/Popover";
import {
  ChevronDown,
  Settings,
  Sparkles,
  StickyNote,
} from "../../../shared/ui/icons";
import {
  sameProviderAccountId,
  supportsProviderAccounts,
  type ProviderAccount,
  type ProviderAccountProvider,
} from "../../providers/model/providerAccounts";
import {
  getAllRateLimits,
  getCachedRateLimits,
  loadRateLimits,
  subscribeRateLimits,
} from "../../providers/model/rateLimitsCache";
import {
  BalancedAccountRow,
  useBalancedAccountIds,
  ProviderAccountRow,
  REMOVED_ACCOUNT_LABEL,
  useProviderAccounts,
} from "../../providers/ui/ProviderAccountRow";
import type { HarnessId, RuntimeMode } from "../../sessions/model/session";
import { AccessPicker } from "../../sessions/ui/AccessPicker";
import { HarnessIcon } from "../../sessions/ui/HarnessIcon";
import { ModelPicker, ModelSettingRows } from "../../sessions/ui/ModelPicker";
import {
  defaultMonoName,
  findMono,
  saveMonoName,
  subscribeMonos,
  updateMono,
  type MonoLook,
  type MonoState,
} from "../model/mono";
import { setEmployeeLocalOnly } from "../model/employeeScope";
import { employeeHome } from "../model/employeeStorage";
import { ConfirmReset } from "./ConfirmReset";
import { MemoryPage, SoulPage, useMonoFiles } from "./MonoFilePages";
import { MonoProjects } from "./MonoProjects";
import { ColleagueAvatar } from "./ColleagueAvatar";
import { ColleagueLookPicker } from "./ColleagueLookPicker";
import { SwitchRow } from "./monoPanelParts";

export type MonoSettingsSection = "general" | "soul" | "memory";

const SECTIONS: {
  id: MonoSettingsSection;
  label: string;
  icon: typeof Settings;
}[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "soul", label: "Soul", icon: Sparkles },
  { id: "memory", label: "Memory", icon: StickyNote },
];

type Props = {
  monoId: string;
  agent: MonoLook;
  /** Its soul and memory reload when a turn ends. */
  status: MonoState["status"];
  /** Its conversation's folder, which the model picker reads settings from. */
  cwd: string;
  harness: HarnessId;
  model: string;
  modelSettings: Record<string, string>;
  /** Unset means the provider CLI's own login. */
  providerAccountId?: string;
  /** It runs on whichever account has the most room. */
  balanced?: boolean;
  runtimeMode: RuntimeMode;
  busy?: boolean;
  initialSection?: MonoSettingsSection;
  onModelChange: (harness: HarnessId, model: string) => void;
  onModelSettingsChange: (settings: Record<string, string>) => void;
  onAccountChange?: (accountId: string) => void;
  onBalanced?: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onReset?: () => Promise<void>;
  onClose: () => void;
};

/**
 * Who the Mono is and how it works, in a dialog of its own: its name, face,
 * model and projects under General, then its soul and memory.
 */
export function MonoSettingsDialog({
  monoId,
  agent,
  status,
  initialSection = "general",
  onClose,
  ...general
}: Props) {
  const [section, setSection] = useState(initialSection);
  const files = useMonoFiles(monoId, status);
  return (
    <Modal
      title={`${agent.name} settings`}
      size="lg"
      minimalHeader
      fitViewport
      onClose={onClose}
      // Centre the close button in the section header's 40px row.
      className="h-[min(680px,calc(100dvh-32px))] [&>.modal-panel>header]:top-1.5"
    >
      <div
        className="flex h-full min-h-0 font-sans"
        // Section headers leave room for the dialog's close button.
        style={{ "--mono-window-controls-width": "2rem" } as CSSProperties}
        data-mono-settings
      >
        <nav
          aria-label="Settings sections"
          className="flex w-48 shrink-0 flex-col gap-px border-r border-stroke p-2"
        >
          <p className="px-2.5 pb-2 pt-1.5 text-[11px] text-content/45">
            Settings
          </p>
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? "page" : undefined}
              onClick={() => setSection(id)}
              className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] ${
                section === id
                  ? "bg-content/8 text-content"
                  : "text-content/65 hover:bg-content/5 hover:text-content"
              }`}
            >
              <Icon className="size-3.5 shrink-0" strokeWidth={1.75} />
              {label}
            </button>
          ))}
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {section === "general" ? (
            <GeneralSection monoId={monoId} agent={agent} {...general} />
          ) : section === "soul" ? (
            <SoulPage monoId={monoId} agent={agent} files={files} />
          ) : (
            <MemoryPage monoId={monoId} files={files} />
          )}
        </div>
      </div>
    </Modal>
  );
}

function GeneralSection({
  monoId,
  agent,
  cwd,
  harness,
  model,
  modelSettings,
  providerAccountId,
  balanced = false,
  runtimeMode,
  busy = false,
  onModelChange,
  onModelSettingsChange,
  onAccountChange,
  onBalanced,
  onRuntimeModeChange,
  onReset,
}: Omit<Props, "status" | "initialSection" | "onClose">) {
  const lock = useLockOverscroll<HTMLDivElement>();
  const shown = useSyncExternalStore(
    subscribeMonos,
    () => findMono(monoId)?.showStartedSessionsInSidebar === true,
  );
  const folders = useSyncExternalStore(
    subscribeMonos,
    () => findMono(monoId)?.useSidebarFolders === true,
  );
  return (
    <div
      ref={lock}
      className="min-h-0 flex-1 overflow-y-auto overscroll-none px-8 pb-8 pt-6"
    >
      <h3 className="text-[14px] font-medium text-content">General</h3>

      <div className="flex flex-col items-center pb-6 pt-4">
        <LookButton monoId={monoId} agent={agent} />
        <NameField key={monoId} monoId={monoId} fallback={agent.mascot} />
      </div>

      <GroupHeading title="Model" />
      <SettingGroup>
        <SettingRow
          label="Model"
          description="What it thinks and replies with."
        >
          <ModelPicker
            harness={harness}
            model={model}
            values={modelSettings}
            project={cwd}
            hideSettings
            side="bottom"
            variant="plain"
            onChange={onModelChange}
            onSettingsChange={onModelSettingsChange}
          />
        </SettingRow>
        <ModelSettingRows
          harness={harness}
          model={model}
          values={modelSettings}
          side="bottom"
          onSettingsChange={onModelSettingsChange}
          row={({ label, control }) => (
            <SettingRow label={label}>{control}</SettingRow>
          )}
        />
        {onAccountChange ? (
          <AccountRow
            harness={harness}
            accountId={providerAccountId}
            balanced={balanced}
            busy={busy}
            onChange={onAccountChange}
            onBalanced={onBalanced}
          />
        ) : null}
        <SettingRow
          label="Permissions"
          description="What it may do without asking."
        >
          <AccessPicker
            value={runtimeMode}
            onChange={onRuntimeModeChange}
            busy={busy}
            side="bottom"
            variant="plain"
          />
        </SettingRow>
      </SettingGroup>

      <GroupHeading
        title="Projects"
        description="It can see every session, note and folder in these."
      />
      <SettingGroup>
        <MonoProjects monoId={monoId} projects={agent.projects} />
      </SettingGroup>

      <GroupHeading title="Sessions it starts" />
      <SettingGroup>
        <SwitchRow
          label="Show sessions in sidebar"
          description="Sessions it starts appear in your project sidebar. Hidden ones stay saved and open from its overview."
          on={shown}
          onChange={(on) =>
            updateMono(monoId, (mono) => ({
              ...mono,
              showStartedSessionsInSidebar: on,
            }))
          }
        />
        {/* Hidden sessions have no sidebar folder to go in. */}
        <SwitchRow
          label="Group in a folder"
          description={`Sessions it starts go in a “${agent.name}” folder in your project sidebar.`}
          on={shown && folders}
          disabled={!shown}
          onChange={(on) =>
            updateMono(monoId, ({ useSidebarFolders: _, ...mono }) =>
              on ? { ...mono, useSidebarFolders: true } : mono,
            )
          }
        />
      </SettingGroup>

      <LocalOnlyGroup monoId={monoId} />

      {onReset ? (
        <>
          <GroupHeading title="Conversation" />
          <ConfirmReset
            label="Reset conversation"
            title={`Reset ${agent.name}'s conversation?`}
            body="All messages in this Colleague's conversation will be deleted and any active reply will be stopped. This can't be undone."
            kept="Its soul, memory and habits will be kept."
            failure="Could not reset the conversation."
            onConfirm={onReset}
          >
            {(open, ref) => (
              <SettingGroup>
                <SettingRow
                  label="Reset conversation"
                  description="Clear all messages and start fresh. Its soul, memory and habits stay."
                >
                  <button
                    ref={ref}
                    type="button"
                    onClick={open}
                    className="rounded-md border border-stroke px-3 py-1.5 text-[12px] text-red-400 hover:bg-red-500/10"
                  >
                    Reset
                  </button>
                </SettingRow>
              </SettingGroup>
            )}
          </ConfirmReset>
        </>
      ) : null}
    </div>
  );
}

/**
 * Whether it is shared through the home machine or kept on this computer.
 * Only shown when a home machine keeps employees; without one, every
 * employee is this computer's already.
 */
function LocalOnlyGroup({ monoId }: { monoId: string }) {
  const [home, setHome] = useState<string>();
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string>();
  const localOnly = useSyncExternalStore(
    subscribeMonos,
    () => findMono(monoId)?.localOnly === true,
  );
  useEffect(() => {
    let live = true;
    employeeHome()
      .then((machine) => live && setHome(machine?.name))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (!home) return null;
  const change = (on: boolean) => {
    setMoving(true);
    setError(undefined);
    setEmployeeLocalOnly(monoId, on)
      .catch(() =>
        setError(
          `Could not reach ${home}. Nothing was moved; try again once it is back.`,
        ),
      )
      .finally(() => setMoving(false));
  };
  return (
    <>
      <GroupHeading
        title="Where it lives"
        description={`Colleagues are shared through ${home}, so every computer has the same ones.`}
      />
      <SettingGroup>
        <SwitchRow
          label="Keep on this computer only"
          description={`Its soul, memory, habits and conversation stay here, and your other computers no longer list it. Turning it off shares it through ${home} again.`}
          on={localOnly}
          disabled={moving}
          onChange={change}
        />
      </SettingGroup>
      {error ? (
        <p className="px-1 pt-2 text-[12px] text-red-400">{error}</p>
      ) : null}
    </>
  );
}

/** A titled group of settings, with what it covers under the title. */
function GroupHeading({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="px-1 pb-2 pt-7">
      <h4 className="text-[12px] font-medium text-content/70">{title}</h4>
      {description ? (
        <p className="text-[12px] leading-5 text-content/40">{description}</p>
      ) : null}
    </div>
  );
}

/** Settings that belong together, in one card with a line between rows. */
function SettingGroup({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-stroke rounded-xl border border-stroke bg-content/[0.02]">
      {children}
    </div>
  );
}

/**
 * A setting's name and what it does on the left, its control on the right.
 * Controls get a column of their own, wide enough that a value is never cut.
 */
function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-12 items-center gap-4 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13px] leading-5 text-content/90">{label}</span>
        {description ? (
          <span className="text-[12px] leading-5 text-content/40">
            {description}
          </span>
        ) : null}
      </div>
      <div className="flex w-56 shrink-0 items-center justify-end pr-1.5 text-[12px] text-content/85">
        {children}
      </div>
    </div>
  );
}

/**
 * Which login of its provider it runs on, shown once there is more than one
 * to choose from, or Balanced between them. Its conversation carries over
 * to the new account.
 */
function AccountRow({
  harness,
  accountId,
  balanced,
  busy,
  onChange,
  onBalanced,
}: {
  harness: HarnessId;
  accountId?: string;
  balanced: boolean;
  busy: boolean;
  onChange: (accountId: string) => void;
  onBalanced?: () => void;
}) {
  const accounts = useProviderAccounts(harness);
  if (accounts.length < 2 || !supportsProviderAccounts(harness)) return null;
  return (
    <SettingRow
      label="Account"
      description={
        busy
          ? "Change it once the current reply ends."
          : balanced
            ? "Runs on the account with the most room."
            : "Whose plan its replies count against."
      }
    >
      <AccountPicker
        provider={harness}
        accounts={accounts}
        accountId={accountId}
        balanced={balanced}
        disabled={busy}
        onChange={onChange}
        onBalanced={onBalanced}
      />
    </SettingRow>
  );
}

function AccountPicker({
  provider,
  accounts,
  accountId,
  balanced,
  disabled,
  onChange,
  onBalanced,
}: {
  provider: ProviderAccountProvider;
  accounts: ProviderAccount[];
  accountId?: string;
  balanced: boolean;
  disabled: boolean;
  onChange: (accountId: string) => void;
  onBalanced?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const button = useRef<HTMLButtonElement>(null);
  const listId = useId();
  // Any account's new reading redraws the list.
  useSyncExternalStore(subscribeRateLimits, getAllRateLimits, getAllRateLimits);
  const current = accounts.find((account) =>
    sameProviderAccountId(account.id, accountId),
  );
  const currentLabel = current?.label ?? REMOVED_ACCOUNT_LABEL;
  const pool = useBalancedAccountIds(provider);
  const poolLabels = accounts
    .filter((account) => pool.has(account.id))
    .map((account) => account.label);
  // Balanced first, then each account.
  const options = [
    ...(onBalanced ? ["balanced"] : []),
    ...accounts.map((account) => account.id),
  ];
  const selected = balanced && onBalanced ? "balanced" : current?.id;
  const dismiss = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) button.current?.focus();
  };
  const pick = (option: string) => {
    dismiss(true);
    if (option === selected) return;
    if (option === "balanced") onBalanced?.();
    else onChange(option);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActive(
        (index) => (index + direction + options.length) % options.length,
      );
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = options[active];
      if (option) pick(option);
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        disabled={disabled}
        aria-label={`Account: ${balanced ? "Balanced" : currentLabel}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-mono-settings-account
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (open) dismiss(true);
          else {
            setActive(Math.max(0, selected ? options.indexOf(selected) : 0));
            setNow(Date.now());
            setOpen(true);
            for (const account of accounts)
              void loadRateLimits(provider, account.id).catch(() => undefined);
          }
        }}
        className={`-mx-1.5 flex h-7 max-w-52 items-center gap-2 rounded-md px-1.5 text-[12px] text-content/85 disabled:opacity-50 ${
          open ? "bg-content/8" : "enabled:hover:bg-content/6"
        }`}
      >
        <HarnessIcon harness={provider} className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          {balanced ? "Balanced" : currentLabel}
        </span>
        {balanced && current ? (
          <span className="min-w-0 truncate text-content/45">
            {current.label}
          </span>
        ) : null}
        <ChevronDown
          className={`size-3 shrink-0 text-content/50 ${open ? "rotate-180" : ""}`}
          strokeWidth={1.75}
        />
      </button>
      {open ? (
        <Popover
          anchor={button}
          side="bottom"
          width={320}
          maxHeight={360}
          autoFocus
          onDismiss={(reason) => dismiss(reason === "escape")}
          ignore="[data-mono-settings-account]"
          role="listbox"
          aria-label="Account"
          aria-activedescendant={`${listId}-${active}`}
          tabIndex={-1}
          onKeyDown={onKeyDown}
          className="flex flex-col gap-1 overflow-y-auto p-1 font-sans text-content"
        >
          {onBalanced ? (
            <BalancedAccountRow
              id={`${listId}-0`}
              role="option"
              pool={poolLabels}
              checked={balanced}
              currentLabel={current?.label}
              highlighted={active === 0}
              onSelect={() => pick("balanced")}
              onHighlight={() => setActive(0)}
            />
          ) : null}
          {!current && accountId ? (
            <ProviderAccountRow
              role="option"
              provider={provider}
              accountId={accountId}
              label={REMOVED_ACCOUNT_LABEL}
              limits={undefined}
              now={now}
              checked={!balanced}
              removed
              onSelect={() => undefined}
            />
          ) : null}
          {accounts.map((account) => {
            const index = options.indexOf(account.id);
            return (
              <ProviderAccountRow
                key={account.id}
                id={`${listId}-${index}`}
                role="option"
                provider={provider}
                accountId={account.id}
                label={account.label}
                limits={getCachedRateLimits(provider, account.id)}
                now={now}
                checked={account.id === selected}
                balanced={
                  onBalanced && accounts.length > 1
                    ? pool.has(account.id)
                    : undefined
                }
                highlighted={index === active}
                onSelect={() => pick(account.id)}
                onHighlight={() => setActive(index)}
              />
            );
          })}
        </Popover>
      ) : null}
    </>
  );
}

/** The Mono's face, which opens its mascots and colors in a popover. */
function LookButton({ monoId, agent }: { monoId: string; agent: MonoLook }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-label="Change face and color"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Change face and color"
        onClick={() => setOpen((value) => !value)}
        className={`grid size-20 shrink-0 place-items-center rounded-2xl border border-stroke hover:bg-content/8 ${
          open ? "bg-content/8" : "bg-content/4"
        }`}
      >
        <ColleagueAvatar
          mascot={agent.mascot}
          color={agent.color}
          avatar={agent.avatar}
          className="size-12 shrink-0"
        />
      </button>
      {open ? (
        <Popover
          anchor={anchor}
          side="bottom"
          align="center"
          width={272}
          constrainHeight={false}
          onDismiss={() => setOpen(false)}
          role="dialog"
          aria-label="Face and color"
          className="flex flex-col gap-3 p-3"
        >
          <ColleagueLookPicker monoId={monoId} look={agent} columns={5} />
        </Popover>
      ) : null}
    </>
  );
}

/** The Mono's name, edited in place; empty goes back to its mascot's name. */
function NameField({ monoId, fallback }: { monoId: string; fallback: string }) {
  const saved = () => findMono(monoId)?.name ?? "";
  const [draft, setDraft] = useState(saved);
  const editing = useRef(false);
  // A reset clears the name while this dialog is open.
  useEffect(
    () =>
      subscribeMonos(() => {
        if (!editing.current) setDraft(saved());
      }),
    [monoId],
  );
  const placeholder = defaultMonoName(fallback);
  const save = () => {
    const name = draft.trim().slice(0, 40);
    if (name !== saved()) saveMonoName(monoId, name);
    setDraft(name);
  };
  return (
    <input
      aria-label="Name"
      value={draft}
      placeholder={placeholder}
      maxLength={40}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => (editing.current = true)}
      onBlur={() => {
        editing.current = false;
        save();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !isImeComposition(event.nativeEvent)) {
          event.currentTarget.blur();
        }
        if (event.key === "Escape") {
          setDraft(saved());
          event.currentTarget.blur();
        }
      }}
      className="mt-3 h-8 w-full max-w-64 rounded-md bg-transparent px-2 text-center text-[15px] font-medium text-content outline-none placeholder:text-content/60 hover:bg-content/5 focus:bg-content/5"
    />
  );
}
