import { Inbox } from "lucide-react";
import { Panel } from "../ui/dialog";
import { Select } from "../ui/Select";
import { useRecorder } from "./audio";
import { QUICK_NOTES, WEB_CLIPS, destinationTitle } from "./destinations";
import { RecordingPanel } from "./Recorder";
import type { CaptureProps } from "./types";
import { useCaptureDraft } from "./useCaptureDraft";
import { useSharedItem } from "./useSharedItem";
import { useCaptureSave } from "./useCaptureSave";
import { useVoiceCapture } from "./useVoiceCapture";
import { CaptureBox, type CaptureBoxProps } from "./CaptureBox";

function SharedChoice({ props, shared }: CaptureBoxProps) {
  const { t } = props;
  const choices = [
    { value: "", label: t("captureText") },
    ...props.shared.map((id, index) => ({
      value: id,
      label: t("capturePending") + " " + (index + 1),
    })),
  ];

  if (!props.shared.length) return null;

  return (
    <Select
      label={t("captureShared")}
      value={shared.item}
      choices={choices}
      change={shared.pick}
      className="captureshared"
    />
  );
}

function CaptureFooter({ props, draft, shared, saving }: CaptureBoxProps) {
  const { book, t } = props;
  const { busy, space } = saving;
  const ready = !busy && !shared.loading && !draft.recording && draft.content;
  const place =
    space === book.id
      ? destinationTitle(book, draft.clipping ? WEB_CLIPS : QUICK_NOTES, t)
      : t(draft.clipping ? "webClips" : "quickNotes");

  return (
    <footer>
      <span className="captureplace">
        <Inbox />
        <Select
          label={t("workspace")}
          value={space}
          choices={props.books.map(([id, title]) => ({
            value: id,
            label: title,
          }))}
          change={(next) => {
            if (!busy) saving.choose(next);
          }}
        />
        <span className="muted placename">/ {place}</span>
      </span>
      <button type="button" disabled={busy} onClick={props.close}>
        {t("cancel")}
      </button>
      <button
        type="button"
        className="primary"
        disabled={!ready}
        onClick={() => void saving.save()}
      >
        {t("save")}
        {!props.mobile && <kbd>⌘↩</kbd>}
      </button>
    </footer>
  );
}

export function Capture(props: CaptureProps) {
  const { book, t } = props;
  const lang = String(book.settings.get("language") ?? "de");
  const draft = useCaptureDraft(props);
  const shared = useSharedItem(props.shared, draft);
  const recorder = useRecorder();
  const saving = useCaptureSave({ props, draft, shared, recorder, lang });
  const voice = useVoiceCapture(props, draft, recorder, saving);
  const box = { props, draft, shared, saving, voice };

  if (draft.recording)
    return (
      <RecordingPanel
        title={t("voiceNote")}
        finishLabel={t("save")}
        recorder={recorder}
        book={book}
        lang={lang}
        t={t}
        submit={voice.take}
        close={() => draft.setRecording(false)}
        discarded={voice.drop}
      />
    );

  return (
    <Panel
      title={t("capture")}
      t={t}
      className="capture"
      keep={draft.content || saving.busy}
      close={() => {
        if (!saving.busy) props.close();
      }}
    >
      <SharedChoice {...box} />
      <CaptureBox {...box} />
      {draft.error && <p role="alert">{draft.error}</p>}
      <CaptureFooter {...box} />
    </Panel>
  );
}
