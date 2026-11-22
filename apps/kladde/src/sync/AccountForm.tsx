import { LoaderCircle } from "lucide-react";
import type { T } from "../locale/locale";
import {
  ACTION_WORDS,
  signsIn,
  type AccountInfo,
  type RecoveryPhrase,
  type SyncAction,
} from "./accountTypes";
import type { SyncAccount } from "./useSyncAccount";

const MIN_USER = 3;
const MAX_USER = 64;
const MIN_PASSWORD = 12;
const MAX_PASSWORD = 1024;
const SERVER_EXAMPLE = "https://sync.example.org";

interface FormProps {
  t: T;
  account: SyncAccount;
  connect: () => Promise<void>;
}

function PasswordFields({ t, action }: { t: T; action: SyncAction }) {
  const newPassword = action === "change" || action === "recover";
  const current = signsIn(action) || action === "revoke";

  return (
    <>
      {action === "change" && (
        <label>
          {t("oldPassword")}
          <input
            type="password"
            name="previous"
            required
            autoComplete="current-password"
            maxLength={MAX_PASSWORD}
          />
        </label>
      )}
      {action === "recover" && (
        <label>
          {t("recovery")}
          <input name="recovery" type="password" required autoComplete="off" />
        </label>
      )}
      <label>
        {newPassword ? t("newPassword") : t("password")}
        <input
          name="password"
          type="password"
          required
          minLength={MIN_PASSWORD}
          maxLength={MAX_PASSWORD}
          autoComplete={current ? "current-password" : "new-password"}
        />
      </label>
    </>
  );
}

function PhraseCheck({ t, phrase }: { t: T; phrase: RecoveryPhrase }) {
  return (
    <div className="phrasebox">
      <h3>{t("recovery")}</h3>
      <p className="phrase">{phrase[0]}</p>
      {[phrase[1], phrase[2]].map((word, index) => (
        <label key={word}>
          {t("word")} {word + 1}
          <input
            name={index ? "second" : "first"}
            required
            autoComplete="off"
          />
        </label>
      ))}
    </div>
  );
}

function FormLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="link" onClick={onClick}>
      {label}
    </button>
  );
}

function FormFooter({ t, account }: FormProps) {
  const { info, action, busy, chooseAction } = account;
  const backToLogin = () => chooseAction("login");

  return (
    <footer>
      {!info && action === "login" && (
        <FormLink
          label={t("forgotPassword")}
          onClick={() => chooseAction("recover")}
        />
      )}
      {info && (action === "revoke" || action === "renew") && (
        <FormLink label={t("cancel")} onClick={backToLogin} />
      )}
      {!info && action === "recover" && (
        <FormLink label={t("backToLogin")} onClick={backToLogin} />
      )}
      <button className="primary" disabled={busy}>
        {busy && <LoaderCircle className="spin" />}
        {busy ? t("syncing") : t(ACTION_WORDS[action])}
      </button>
    </footer>
  );
}

function ServerFields({
  t,
  info,
}: {
  t: T;
  info: AccountInfo | null | undefined;
}) {
  return (
    <>
      <label>
        {t("server")}
        <input
          name="origin"
          type="url"
          required
          defaultValue={info?.[0] ?? ""}
          placeholder={SERVER_EXAMPLE}
        />
      </label>
      <label>
        {t("user")}
        <input
          name="user"
          required
          minLength={MIN_USER}
          maxLength={MAX_USER}
          autoComplete="username"
          defaultValue={info?.[1]}
        />
      </label>
    </>
  );
}

export function AccountForm(props: FormProps) {
  const { t, account } = props;
  const { action, phrase, error } = account;
  const rekeys =
    action === "change" || action === "recover" || action === "revoke";

  return (
    <form
      key={account.info?.[3] ?? "login"}
      ref={account.form}
      className="stacked"
      onSubmit={(event) => {
        event.preventDefault();
        void props.connect();
      }}
    >
      <ServerFields t={t} info={account.info} />
      <PasswordFields t={t} action={action} />
      {!signsIn(action) && <p className="hint">{t("security")}</p>}
      {rekeys && <p className="hint">{t("rekeyNotice")}</p>}
      {phrase && <PhraseCheck t={t} phrase={phrase} />}
      {error && (
        <p className="formerror" role="alert">
          {error}
        </p>
      )}
      <FormFooter {...props} />
    </form>
  );
}
