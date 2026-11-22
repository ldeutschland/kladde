import { Panel } from "../ui/dialog";
import { Select } from "../ui/Select";
import {
  clock,
  failureWord,
  languageName,
  shortLanguageName,
  recordingName,
  transcriptBlocks,
  useRecorder,
  type Recording,
  type RecorderState,
} from "./audio";
import type { Entry, Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import {
  BARS,
  useRecordingSession,
  type SessionOptions,
} from "./useRecordingSession";

const QUIET_BAR = 0.06;

type Session = ReturnType<typeof useRecordingSession>;

export type NoteBlock =
  | { type: "audio"; props: { name: string; url: string } }
  | { type: "paragraph"; content: string };

function Meter({ levels }: { levels: number[] }) {
  const quiet = Array.from({ length: BARS - levels.length }, () => 0);

  return (
    <div className="meter" aria-hidden="true">
      {[...quiet, ...levels].map((level, index) => (
        <span
          key={index}
          style={{ transform: `scaleY(${Math.max(QUIET_BAR, level)})` }}
        />
      ))}
    </div>
  );
}

function recorderStatus(state: RecorderState, t: T) {
  if (state.model) return t("recordModel");
  if (state.phase === "starting") return t("recordStarting");
  if (state.phase === "paused") return t("recordPaused");
  if (state.phase === "finishing") return t("recordFinishing");
  if (state.phase === "recording") return t("recording");

  return "";
}

function recorderProblem(state: RecorderState, t: T) {
  if (!state.error) return "";

  return t(failureWord(state.error)).replace("{error}", state.error);
}

export function Recorder({
  book,
  entry,
  lang,
  t,
  insert,
  close,
  notify,
}: {
  book: Notebook;
  entry: Entry;
  lang: string;
  t: T;
  insert: (blocks: NoteBlock[]) => void;
  close: () => void;
  notify: (text: string) => void;
}) {
  const recorder = useRecorder();

  async function submit(result: Recording, keep: boolean) {
    const blocks: NoteBlock[] = [];

    if (keep) {
      const name = recordingName(t("audioNote"), lang);
      const url = await recorder.save(book, entry, name);

      blocks.push({ type: "audio", props: { name, url } });
    } else await recorder.discard();
    blocks.push(...transcriptBlocks(result.text));
    if (blocks.length) insert(blocks);
    if (!blocks.length) notify(t("recordNothing"));
    else if (!result.transcribed) notify(t("recordNoTranscript"));
  }

  return (
    <RecordingPanel
      title={t("audioNote")}
      finishLabel={t("recordDone")}
      recorder={recorder}
      book={book}
      lang={lang}
      t={t}
      submit={submit}
      close={close}
      discarded={close}
    />
  );
}

interface PanelPartProps {
  session: Session;
  state: RecorderState;
  lang: string;
  t: T;
}

function RecordHead({ session, state, lang, t }: PanelPartProps) {
  const { language, languages, saving } = session;
  const status = saving ? t("recordSaving") : recorderStatus(state, t);
  const quietStatus = !saving && state.phase === "recording" && !state.model;

  return (
    <div className="recordhead" data-phase={state.phase}>
      <span className="recorddot" aria-hidden="true" />
      <span className="recordclock">{clock(state.seconds)}</span>
      <p
        className={"recordstatus" + (quietStatus ? " hidden" : "")}
        role="status"
      >
        {status}
      </p>
      <Select
        className="recordlanguage"
        label={t("recordLanguage")}
        value={language}
        choices={languages.map((id) => ({
          value: id,
          label: languageName(id, lang),
        }))}
        change={session.choose}
        shown={shortLanguageName(language, lang, languages)}
      />
    </div>
  );
}

function RecordText({ state, t }: Pick<PanelPartProps, "state" | "t">) {
  const heard = state.settled || state.pending;

  return (
    <div className="recordtext" aria-live="polite">
      {state.settled}
      {state.pending && <span className="pendingtext"> {state.pending}</span>}
      {!heard && <span className="muted">{t("recordHint")}</span>}
    </div>
  );
}

export function RecordingPanel({
  title,
  finishLabel,
  ...options
}: SessionOptions & { title: string; finishLabel: string }) {
  const { recorder, lang, t } = options;
  const { state } = recorder;
  const session = useRecordingSession(options);
  const { language, started, live } = session;
  const failed = session.problem || recorderProblem(state, t);

  return (
    <Panel
      title={title}
      t={t}
      className="recorder"
      bare
      close={() => void session.cancel()}
    >
      <RecordHead session={session} state={state} lang={lang} t={t} />
      <div className="recordwave" data-phase={state.phase}>
        <Meter levels={session.levels} />
      </div>
      <RecordText state={state} t={t} />
      {language !== started && live && (
        <p className="recordnote">{t("recordLanguageChanged")}</p>
      )}
      {failed && <p role="alert">{failed}</p>}
      <button
        type="button"
        className="switchitem recordkeep"
        aria-pressed={session.keep}
        onClick={session.toggleKeep}
      >
        {t("recordKeepAudio")}
        <span className="switch" />
      </button>
      <RecorderActions
        state={state}
        busy={session.busy}
        storing={session.storing}
        live={live}
        finishLabel={finishLabel}
        t={t}
        restart={() => void session.restart()}
        pause={recorder.pause}
        resume={recorder.resume}
        cancel={() => void session.cancel()}
        finish={() => void session.finish()}
      />
    </Panel>
  );
}

function RecorderActions({
  state,
  busy,
  storing,
  live,
  finishLabel,
  t,
  restart,
  pause,
  resume,
  cancel,
  finish,
}: {
  state: RecorderState;
  busy: boolean;
  storing: boolean;
  live: boolean;
  finishLabel: string;
  t: T;
  restart: () => void;
  pause: () => void;
  resume: () => void;
  cancel: () => void;
  finish: () => void;
}) {
  const paused = state.phase === "paused";
  const idle = state.phase === "idle";
  const toggle = idle ? restart : paused ? resume : pause;
  const toggleLabel = idle
    ? t("recordStart")
    : paused
      ? t("recordResume")
      : t("recordPause");

  return (
    <footer className="recordactions">
      <button
        type="button"
        disabled={busy || state.phase === "starting"}
        onClick={toggle}
      >
        {toggleLabel}
      </button>
      <button type="button" disabled={storing} onClick={cancel}>
        {t("recordDiscard")}
      </button>
      <button
        type="button"
        className="primary"
        disabled={!live || busy}
        onClick={finish}
      >
        {finishLabel}
      </button>
    </footer>
  );
}
