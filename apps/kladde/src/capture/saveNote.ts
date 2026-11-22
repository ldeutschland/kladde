import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import type { Entry, Notebook } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { blockEditor, markdown, writeMarkdown } from "../notebook/content";
import { fileBlockType, saveFile } from "../files/attachments";
import { addRow, quickNotesDatabase } from "./destinations";
import { recordingName } from "./audio";
import type { Draft, RecorderControls } from "./types";

const TITLE_LENGTH = 200;

export interface NoteToSave {
  target: Notebook;
  key: string;
  draft: Draft;
  file: File | undefined;
  recorder: RecorderControls;
  t: T;
  lang: string;
}

async function noteEntry(note: NoteToSave, title: string) {
  const { target, key, t } = note;
  const existing = target.pages.get(key);

  if (existing?.archived) throw Error(t("pageUnavailable"));
  if (!existing)
    return addRow(target, await quickNotesDatabase(target, t), title, key);
  const entry = await target.load(key);

  if (entry.doc.getMap("meta").get("captureId") !== key)
    throw Error(t("pageUnavailable"));

  return entry;
}

async function writeContent(note: NoteToSave, entry: Entry, voiceName: string) {
  const { target, draft, file } = note;
  const body = draft.text.trim();

  writeMarkdown(entry, body);
  if (!file && draft.spoken === null) return;
  const editor = blockEditor();
  const parsed = editor.tryParseMarkdownToBlocks(body);

  if (file)
    parsed.push({
      type: fileBlockType(file),
      props: { name: file.name, url: await saveFile(target, entry, file) },
    } as (typeof parsed)[number]);
  if (draft.spoken !== null)
    parsed.push({
      type: "audio",
      props: {
        name: voiceName,
        url: await note.recorder.save(target, entry, voiceName),
      },
    } as (typeof parsed)[number]);
  blocksToYXmlFragment(editor, parsed, entry.doc.getXmlFragment("blocks"));
  entry.doc.getMap("meta").set("text", markdown(entry));
}

export async function saveNote(note: NoteToSave) {
  const voiceName = recordingName(note.t("voiceNote"), note.lang);
  const firstLine = note.draft.text.trim().split("\n")[0];
  const title = (note.file?.name || firstLine || voiceName).slice(
    0,
    TITLE_LENGTH,
  );
  const entry = await noteEntry(note, title);
  const meta = entry.doc.getMap("meta");

  meta.set("captureId", note.key);
  if (meta.get("captured") === true) return;
  await writeContent(note, entry, voiceName);
  meta.set("captured", true);
}

export async function saveClip(
  target: Notebook,
  key: string,
  address: string,
  t: T,
) {
  const clipper = await import("./clipper");

  await clipper.saveClip(target, address.trim(), t, key);
}
