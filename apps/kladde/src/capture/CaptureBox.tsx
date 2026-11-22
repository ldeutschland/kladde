import { useRef, type RefObject } from "react";
import { Check, KeyboardOff, Mic, Newspaper, Paperclip, X } from "lucide-react";
import { clock } from "./audio";
import type { CaptureProps } from "./types";
import type { CaptureDraft } from "./useCaptureDraft";
import type { SharedItemState } from "./useSharedItem";
import type { CaptureSave } from "./useCaptureSave";
import type { VoiceCapture } from "./useVoiceCapture";

const MAX_TEXT = 100000;
const TEXT_ROWS = 5;

export interface CaptureBoxProps {
  props: CaptureProps;
  draft: CaptureDraft;
  shared: SharedItemState;
  saving: CaptureSave;
  voice: VoiceCapture;
}

function Attachments({ props, draft, shared, saving, voice }: CaptureBoxProps) {
  const { t } = props;
  const { busy } = saving;

  return (
    <>
      {draft.spoken !== null && (
        <span className="chip">
          <Mic />
          <span className="grow">
            {t("voiceNote")} · {clock(draft.spoken)}
          </span>
          <button
            type="button"
            aria-label={t("remove")}
            disabled={busy}
            onClick={() => void voice.remove()}
          >
            <X />
          </button>
        </span>
      )}
      {draft.file && (
        <span className="chip">
          <Paperclip />
          <span className="grow">{draft.file.name}</span>
          {!shared.item && (
            <button
              type="button"
              aria-label={t("remove")}
              disabled={busy}
              onClick={() => draft.setFile(undefined)}
            >
              <X />
            </button>
          )}
        </span>
      )}
    </>
  );
}

function ToolBar({
  box,
  field,
}: {
  box: CaptureBoxProps;
  field: RefObject<HTMLTextAreaElement | null>;
}) {
  const { props, draft, shared, saving } = box;
  const { t } = props;
  const { busy } = saving;
  const picker = useRef<HTMLInputElement>(null);

  return (
    <div className="composerbar">
      {!shared.item && (
        <button
          type="button"
          className="webtoggle"
          disabled={busy}
          onClick={() => picker.current?.click()}
        >
          <Paperclip />
          {t("file")}
        </button>
      )}
      {!shared.item && draft.spoken === null && (
        <button
          type="button"
          className="webtoggle micbutton"
          disabled={busy}
          onClick={() => draft.setRecording(true)}
        >
          <Mic />
          {t("voiceNote")}
        </button>
      )}
      {!draft.file && draft.spoken === null && draft.url && (
        <button
          type="button"
          className="webtoggle"
          aria-pressed={draft.clip}
          disabled={busy}
          onClick={() => draft.setClip(!draft.clip)}
        >
          <Newspaper />
          {t("clipArticle")}
          {draft.clip && <Check />}
        </button>
      )}
      {props.mobile && draft.focused && (
        <button
          type="button"
          className="webtoggle keyboardoff"
          aria-label={t("hideKeyboard")}
          onClick={() => field.current?.blur()}
        >
          <KeyboardOff />
        </button>
      )}
      <input
        ref={picker}
        type="file"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          draft.setFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
    </div>
  );
}

export function CaptureBox(box: CaptureBoxProps) {
  const { props, draft, shared, saving } = box;
  const { t } = props;
  const field = useRef<HTMLTextAreaElement>(null);

  return (
    <div
      className="composer capturebox"
      onDragOver={(event) => {
        if (!shared.item && event.dataTransfer.types.includes("Files"))
          event.preventDefault();
      }}
      onDrop={(event) => {
        const dropped = event.dataTransfer.files[0];

        if (!dropped || shared.item || saving.busy) return;
        event.preventDefault();
        draft.setFile(dropped);
      }}
    >
      <textarea
        ref={field}
        autoFocus={!props.voice && !props.shared.length && !props.photo}
        rows={TEXT_ROWS}
        aria-label={t("captureText")}
        placeholder={t("captureText")}
        maxLength={MAX_TEXT}
        disabled={saving.busy || shared.loading}
        value={draft.text}
        onFocus={() => draft.setFocused(true)}
        onBlur={() => draft.setFocused(false)}
        onChange={(event) => draft.setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey))
            return;
          event.preventDefault();
          void saving.save();
        }}
      />
      <Attachments {...box} />
      <ToolBar box={box} field={field} />
    </div>
  );
}
