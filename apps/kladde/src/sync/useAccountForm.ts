import { command } from "../platform/native";
import {
  readableError,
  signsIn,
  type AccountInfo,
  type RecoveryPhrase,
  type SyncAction,
  type SyncPanelProps,
} from "./accountTypes";
import type { SyncAccount } from "./useSyncAccount";
import type { AccountManagement } from "./useAccountManagement";

const SECRET_FIELDS = ["previous", "recovery", "password"];

function accountInput(form: HTMLFormElement, action: SyncAction) {
  const data = new FormData(form);

  return {
    origin: data.get("origin"),
    user: data.get("user"),
    password: data.get("password"),
    action: signsIn(action) ? "login" : action,
    recovery: data.get("recovery"),
    previous_password: data.get("previous"),
    confirm: [data.get("first") ?? "", data.get("second") ?? ""],
  };
}

function clearSecrets(form: HTMLFormElement) {
  for (const name of SECRET_FIELDS) {
    const field = form.elements.namedItem(name);

    if (field instanceof HTMLInputElement) field.value = "";
  }
}

export function useAccountForm(
  props: SyncPanelProps,
  account: SyncAccount,
  management: AccountManagement,
) {
  const { book } = props;

  async function signIn(input: ReturnType<typeof accountInput>) {
    const space = await command<string>("connect_account", {
      space: book.id,
      input,
    });

    account.setPhrase(null);
    account.setAction("login");
    management.clearDevices();
    account.setInfo(await command<AccountInfo | null>("account_info"));
    if (!(await command("account_info", { space }))) return;
    await account.syncInto(space);
    if (space !== book.id) await props.changeBook(space);
  }

  async function connect() {
    const form = account.form.current;

    if (!form) return;
    account.fail("");

    if (!signsIn(account.action) && !account.phrase) {
      account.setPhrase(await command<RecoveryPhrase>("phrase"));

      return;
    }

    const input = accountInput(form, account.action);

    clearSecrets(form);
    account.setBusy(true);

    try {
      await signIn(input);
    } catch (problem) {
      account.fail(readableError(problem, props.t));
      account.setPhrase(null);
    } finally {
      account.setBusy(false);
    }
  }

  return { connect };
}
