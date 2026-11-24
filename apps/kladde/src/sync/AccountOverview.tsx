import {
  BookOpen,
  KeyRound,
  LoaderCircle,
  LogIn,
  MonitorSmartphone,
  RefreshCw,
  Wrench,
} from "lucide-react";
import { Select } from "../ui/Select";
import { needsRepair, syncDetails, syncLabel } from "./sync";
import type { AccountInfo, SyncPanelProps } from "./accountTypes";
import type { SyncAccount } from "./useSyncAccount";
import type { AccountManagement } from "./useAccountManagement";

const FALLBACK_INITIAL = "K";
const DEVICE_ID_LENGTH = 8;

export interface OverviewProps {
  panel: SyncPanelProps;
  info: AccountInfo;
  account: SyncAccount;
  management: AccountManagement;
}

function AccountCard({ panel, info, account }: OverviewProps) {
  const { t } = panel;

  return (
    <div className="accountcard">
      <span className="avatar">
        {(Array.from(info[1])[0] ?? FALLBACK_INITIAL).toUpperCase()}
      </span>
      <span className="grow accountname">
        <strong>{info[1]}</strong>
        <small>{info[0]}</small>
      </span>
      <button
        disabled={account.busy}
        className="primary"
        onClick={account.sync}
      >
        {account.busy ? <LoaderCircle className="spin" /> : <RefreshCw />}
        {account.busy ? t("syncing") : t("sync")}
      </button>
    </div>
  );
}

function SyncState({ panel, account }: OverviewProps) {
  const { book, t, status } = panel;
  const titleOf = (id: string) => book.pages.get(id)?.title || t("untitled");

  return (
    <div
      className={"syncstatus " + status.phase}
      role="status"
      aria-live="polite"
    >
      <strong>{syncLabel(status, t)}</strong>
      {syncDetails(status, t, titleOf).map((line) => (
        <span key={line}>{line}</span>
      ))}
      {status.phase === "auth" && account.action !== "renew" && (
        <button
          className="outline"
          onClick={() => account.chooseAction("renew")}
        >
          <LogIn />
          {t("signInAgain")}
        </button>
      )}
      {needsRepair(status) && (
        <button
          className="outline"
          disabled={account.busy}
          onClick={account.repair}
        >
          <Wrench />
          {t("repairSync")}
        </button>
      )}
    </div>
  );
}

function AccountButtons({ panel, account, management }: OverviewProps) {
  const { t } = panel;
  const { action, chooseAction } = account;

  return (
    <div className="syncactions">
      <button disabled={account.busy} onClick={management.listRemote}>
        <BookOpen />
        {t("workspace")}
      </button>
      <button disabled={account.busy} onClick={management.listDevices}>
        <MonitorSmartphone />
        {t("devices")}
      </button>
      <button
        aria-pressed={action === "renew"}
        onClick={() => chooseAction(action === "renew" ? "login" : "renew")}
      >
        <LogIn />
        {t("signInAgain")}
      </button>
      <button
        aria-pressed={action === "change"}
        onClick={() => chooseAction(action === "change" ? "login" : "change")}
      >
        <KeyRound />
        {t("changePassword")}
      </button>
      <button disabled={account.busy} onClick={account.repair}>
        <Wrench />
        {t("repairSync")}
      </button>
    </div>
  );
}

function RemoteNotebooks({ panel, management }: OverviewProps) {
  const { book, t } = panel;
  const { remote } = management;
  const label = (id: string) =>
    id === book.id ? String(book.manifest.doc.getMap("meta").get("title")) : id;

  if (!remote.length) return null;

  return (
    <div className="syncrow">
      <Select
        label={t("workspace")}
        value=""
        choices={[
          { value: "", label: t("choose") },
          ...remote.map((id) => ({ value: id, label: label(id) })),
        ]}
        change={management.openRemote}
      />
      {!remote.includes(book.id) && (
        <button className="outline" onClick={management.linkNotebook}>
          {t("connect")}
        </button>
      )}
    </div>
  );
}

function DeviceList({ panel, management }: OverviewProps) {
  return management.devices.map((id) => (
    <div className="line" key={id}>
      <MonitorSmartphone />
      <code className="grow">{id.slice(0, DEVICE_ID_LENGTH)}</code>
      <button onClick={management.removeDevice}>{panel.t("remove")}</button>
    </div>
  ));
}

export function AccountOverview(props: OverviewProps) {
  return (
    <>
      <AccountCard {...props} />
      <SyncState {...props} />
      <AccountButtons {...props} />
      <RemoteNotebooks {...props} />
      <DeviceList {...props} />
    </>
  );
}
