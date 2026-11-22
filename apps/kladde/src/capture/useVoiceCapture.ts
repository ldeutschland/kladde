import type { Recording } from "./audio";
import type { CaptureProps, RecorderControls } from "./types";
import type { CaptureDraft } from "./useCaptureDraft";
import type { CaptureSave } from "./useCaptureSave";

function joined(text: string, addition: string) {
  const [head, tail] = [text.trim(), addition.trim()];

  return head && tail ? head + "\n\n" + tail : head || tail;
}

export function useVoiceCapture(
  props: CaptureProps,
  draft: CaptureDraft,
  recorder: RecorderControls,
  saving: CaptureSave,
) {
  const { t } = props;

  async function take(result: Recording, keep: boolean) {
    const heard = result.text.trim();

    if (!keep) await recorder.discard();
    if (!keep && !heard) return draft.fail(t("recordNothing"));
    const note = {
      text: joined(draft.text, heard),
      spoken: keep ? result.seconds : null,
    };

    draft.setText(note.text);
    draft.setSpoken(note.spoken);
    await saving.store(note, result.transcribed ? "" : t("recordNoTranscript"));
  }

  function drop() {
    draft.setRecording(false);
    if (props.voice && !draft.content) props.close();
  }

  async function remove() {
    await recorder.discard();
    draft.setSpoken(null);
  }

  return { take, drop, remove };
}

export type VoiceCapture = ReturnType<typeof useVoiceCapture>;
