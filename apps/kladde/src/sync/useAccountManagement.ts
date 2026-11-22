import { useState } from "react";
import { command } from "../platform/native";
import { SYNC_OFF } from "./sync";
import { readableError, type SyncPanelProps } from "./accountTypes";
import type { SyncAccount } from "./useSyncAccount";

type Removal = "disconnect" | "erase";

function removalQuestion(props: SyncPanelProps, removal: Removal) {
  const { t } = props;
  const erase = removal === "erase";

  return props.ask(
    t(erase ? "eraseAccountQuestion" : "disconnectQuestion"),
    erase ? "" : undefined,
    {
      detail: t(erase ? "eraseAccountDetail" : "disconnectDetail"),
      action: t(erase ? "delete" : "remove"),
      danger: erase,
      secret: erase,
      placeholder: erase ? t("password") : undefined,
    },
  );
}

export function useAccountManagement(
  props: SyncPanelProps,
  account: SyncAccount,
) {
  const { book, t } = props;
  const [devices, setDevices] = useState<string[]>([]),
    [remote, setRemote] = useState<string[]>([]);

  function linkNotebook() {
    const { info } = account;

    if (!info) return;
    void account.attempt(async () => {
      setRemote(await command("remote_spaces", { link: book.id }));
      book.settings.set("syncAccount", info[1]);
      await account.syncInto(book.id);
    });
  }

  async function removeDevice() {
    const confirmed = await props.ask(t("revokeQuestion"), undefined, {
      detail: t("revokeDetail"),
      action: t("remove"),
      danger: true,
    });

    if (!confirmed) return;
    setDevices([]);
    account.chooseAction("revoke");
  }

  function signedOut() {
    account.setInfo(null);
    account.setAction("login");
    account.setPhrase(null);
    setDevices([]);
    setRemote([]);
    account.form.current?.reset();
    props.setStatus(SYNC_OFF);
  }

  async function removeAccount(removal: Removal) {
    const answer = await removalQuestion(props, removal);

    if (!answer) return;
    account.setBusy(true);
    account.fail("");

    try {
      await command(
        "device_action",
        removal === "erase"
          ? { action: removal, password: answer }
          : { action: removal },
      );
      signedOut();
    } catch (problem) {
      account.fail(readableError(problem, t));
    } finally {
      account.setBusy(false);
    }
  }

  async function openRemote(id: string) {
    if (!id) return;

    try {
      await account.syncInto(id);
      await props.changeBook(id);
    } catch (problem) {
      account.fail(readableError(problem, t));
    }
  }

  return {
    devices,
    clearDevices: () => setDevices([]),
    listDevices: () =>
      account.attempt(async () =>
        setDevices(await command("device_action", { action: "list" })),
      ),
    remote,
    listRemote: () =>
      account.attempt(async () => setRemote(await command("remote_spaces"))),
    openRemote,
    linkNotebook,
    removeDevice,
    removeAccount,
  };
}

export type AccountManagement = ReturnType<typeof useAccountManagement>;
