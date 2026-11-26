import { LogOut, Trash2 } from "lucide-react";
import type { T } from "../locale/locale";
import type { SyncPanelProps } from "./accountTypes";
import { useSyncAccount, type SyncAccount } from "./useSyncAccount";
import { useAccountManagement } from "./useAccountManagement";
import { useAccountForm } from "./useAccountForm";
import { useSyncBooks } from "./useSyncBooks";
import { AccountOverview } from "./AccountOverview";
import { AccountForm } from "./AccountForm";

const START_ACTIONS = ["login", "register"] as const;

function NoAccount({ t, account }: { t: T; account: SyncAccount }) {
  return (
    <>
      <p className="muted">{t("noAccount")}</p>
      {account.action !== "recover" && (
        <div className="segmented wide" role="radiogroup">
          {START_ACTIONS.map((key) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={account.action === key}
              onClick={() => account.chooseAction(key)}
            >
              {t(key)}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

export function SyncPanel(props: SyncPanelProps) {
  const { t } = props;
  const account = useSyncAccount(props);
  const management = useAccountManagement(props, account);
  const books = useSyncBooks(props, account);
  const { connect } = useAccountForm(props, account, management);
  const { info, busy, error } = account;
  const showForm = !info || account.action !== "login";

  return (
    <div className="syncpanel">
      {info ? (
        <AccountOverview
          panel={props}
          info={info}
          account={account}
          management={management}
          books={books}
        />
      ) : (
        <NoAccount t={t} account={account} />
      )}
      {showForm && <AccountForm t={t} account={account} connect={connect} />}
      {!showForm && error && (
        <p className="formerror" role="alert">
          {error}
        </p>
      )}
      {info !== null && (
        <button
          className="outline"
          disabled={busy}
          onClick={() => management.removeAccount("disconnect")}
        >
          <LogOut />
          {t("disconnectAccount")}
        </button>
      )}
      {info && (
        <button
          className="dangerlink"
          disabled={busy}
          onClick={() => management.removeAccount("erase")}
        >
          <Trash2 />
          {t("eraseAccount")}
        </button>
      )}
    </div>
  );
}
