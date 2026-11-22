import type { T } from "../locale/locale";

const SUPPORT_ADDRESS = "kontakt@deutschland.sh";

export function Support({
  t,
  notify,
}: {
  t: T;
  notify: (text: string) => void;
}) {
  function copyAddress() {
    navigator.clipboard
      .writeText(SUPPORT_ADDRESS)
      .then(() => notify(t("copied")))
      .catch(() => notify(t("copyFailed")));
  }

  return (
    <div className="support">
      <p>{t("supportIntro")}</p>
      <p className="supportaddress">{SUPPORT_ADDRESS}</p>
      <button onClick={copyAddress}>{t("copySupportAddress")}</button>
    </div>
  );
}
