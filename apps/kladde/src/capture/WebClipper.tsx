import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  FolderOpen,
  LoaderCircle,
  Plug,
  Trash2,
} from "lucide-react";
import { command } from "../platform/native";
import type { T } from "../locale/locale";

interface Browser {
  name: string;
  connected: boolean;
}
interface ClipperStatus {
  browsers: Browser[];
  folder: string;
  ready: boolean;
}
type Action = "clipper_setup" | "clipper_remove";

const EXTENSIONS_PAGE = "chrome://extensions";
const MAX_FOLDER = 4096;

function isBrowser(value: unknown): value is Browser {
  if (!value || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;

  return typeof raw.name === "string" && typeof raw.connected === "boolean";
}

function readStatus(value: unknown): ClipperStatus {
  const raw = (value ?? {}) as Record<string, unknown>;

  if (
    !Array.isArray(raw.browsers) ||
    !raw.browsers.every(isBrowser) ||
    typeof raw.folder !== "string" ||
    raw.folder.length > MAX_FOLDER ||
    typeof raw.ready !== "boolean"
  )
    throw Error("Invalid status");

  return { browsers: raw.browsers, folder: raw.folder, ready: raw.ready };
}

function reason(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function BrowserList({ status, t }: { status: ClipperStatus; t: T }) {
  if (!status.browsers.length)
    return <p className="muted">{t("clipperNoBrowser")}</p>;

  return (
    <ul className="clipperbrowsers">
      {status.browsers.map((browser) => (
        <li key={browser.name}>
          {browser.connected ? <Check /> : <Plug />}
          <span className="grow">{browser.name}</span>
          <small className={browser.connected ? "" : "muted"}>
            {t(browser.connected ? "clipperConnected" : "clipperNotConnected")}
          </small>
        </li>
      ))}
    </ul>
  );
}

function Steps({
  status,
  t,
  copy,
  fail,
}: {
  status: ClipperStatus;
  t: T;
  copy: (value: string) => void;
  fail: (error: unknown) => void;
}) {
  return (
    <>
      <h3>{t("clipperActivate")}</h3>
      <ol className="clippersteps">
        <li>
          {t("clipperStepOpen")} <code>{EXTENSIONS_PAGE}</code>
          <button className="outline" onClick={() => copy(EXTENSIONS_PAGE)}>
            <Copy />
            {t("copy")}
          </button>
        </li>
        <li>{t("clipperStepDeveloper")}</li>
        <li>
          {t("clipperStepLoad")}
          <span className="syncactions">
            <button onClick={() => void command("clipper_reveal").catch(fail)}>
              <FolderOpen />
              {t("clipperShowFolder")}
            </button>
            <button onClick={() => copy(status.folder)}>
              <Copy />
              {t("clipperCopyPath")}
            </button>
          </span>
        </li>
        <li>{t("clipperStepUse")}</li>
      </ol>
      <p className="muted">{t("clipperNotes")}</p>
    </>
  );
}

export function PhoneClipper({ t }: { t: T }) {
  return (
    <div className="clipperpanel">
      <p className="muted">{t("phoneClipperIntro")}</p>
      <ol className="clippersteps">
        <li>{t("phoneClipperStepShare")}</li>
        <li>{t("phoneClipperStepMode")}</li>
        <li>{t("phoneClipperStepOpen")}</li>
      </ol>
      <p className="muted">{t("phoneClipperNotes")}</p>
    </div>
  );
}

export default function WebClipper({ t, mobile }: { t: T; mobile: boolean }) {
  if (mobile) return <PhoneClipper t={t} />;

  return <DesktopClipper t={t} />;
}

function DesktopClipper({ t }: { t: T }) {
  const [status, setStatus] = useState<ClipperStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const fail = (error: unknown) => setMessage(reason(error));

  useEffect(() => {
    let live = true;

    command("clipper_status")
      .then((value) => live && setStatus(readStatus(value)))
      .catch((error) => live && setMessage(reason(error)));

    return () => {
      live = false;
    };
  }, []);

  async function run(action: Action) {
    setBusy(true);
    setMessage("");

    try {
      setStatus(readStatus(await command(action)));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }

  function copy(value: string) {
    navigator.clipboard
      .writeText(value)
      .then(() => setMessage(t("copied")))
      .catch(fail);
  }

  return (
    <div className="clipperpanel">
      <p className="muted">{t("clipperIntro")}</p>
      {status && <BrowserList status={status} t={t} />}
      <div className="syncactions">
        <button
          className="primary"
          disabled={busy}
          onClick={() => void run("clipper_setup")}
        >
          {busy ? <LoaderCircle className="spin" /> : <Plug />}
          {t(status?.ready ? "clipperRepair" : "clipperSetup")}
        </button>
        {status?.ready && (
          <button disabled={busy} onClick={() => void run("clipper_remove")}>
            <Trash2 />
            {t("clipperRemove")}
          </button>
        )}
      </div>
      {message && <p role="status">{message}</p>}
      {status?.ready && <Steps status={status} t={t} copy={copy} fail={fail} />}
    </div>
  );
}
