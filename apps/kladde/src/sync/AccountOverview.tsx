import {
  KeyRound,
  LoaderCircle,
  LogIn,
  MonitorSmartphone,
  RefreshCw,
  Wrench,
} from "lucide-react";
import { firstLetter } from "../workspace/commands";
import { needsRepair, syncDetails, syncLabel } from "./sync";
import type { AccountInfo, SyncPanelProps } from "./accountTypes";
import type { SyncAccount } from "./useSyncAccount";
import type { AccountManagement } from "./useAccountManagement";
import type { SyncBooks } from "./useSyncBooks";
import { SyncBookList } from "./SyncBookList";

const DEVICE_ID_LENGTH = 8;

export interface OverviewProps {
  panel: SyncPanelProps;
  info: AccountInfo;
  account: SyncAccount;
  management: AccountManagement;
  books: SyncBooks;
}

function AccountCard({ panel, info, account, books }: OverviewProps) {
  const { t } = panel;

  return (
    <div className="accountcard">
      <span className="avatar">{firstLetter(info[1])}</span>
      <span className="grow accountname">
        <strong>{info[1]}</strong>
        <small>{info[0]}</small>
      </span>
      <button
        disabled={account.busy}
        className="primary"
        onClick={() => void books.syncAll()}
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
  const { panel, account, books } = props;

  return (
    <>
      <AccountCard {...props} />
      <SyncState {...props} />
      <SyncBookList
        books={books}
        open={panel.book.id}
        locked={account.busy}
        t={panel.t}
      />
      <h3>{panel.t("account")}</h3>
      <AccountButtons {...props} />
      <DeviceList {...props} />
    </>
  );
}
