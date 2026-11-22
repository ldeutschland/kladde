import { command, fileBase64 } from "../platform/native";

const MAGIC = "KLADDE2\n";
const LENGTH_BYTES = 4;
const PRELUDE = MAGIC.length + LENGTH_BYTES;

async function lengthAt(file: Blob, offset: number) {
  const bytes = await file.slice(offset, offset + LENGTH_BYTES).arrayBuffer();

  if (bytes.byteLength < LENGTH_BYTES) throw Error("Invalid backup");

  return new DataView(bytes).getUint32(0, true);
}

async function isStreamed(file: Blob) {
  const start = await file.slice(0, MAGIC.length).arrayBuffer();

  return new TextDecoder().decode(start) === MAGIC;
}

async function restoreParts(
  file: Blob,
  from: number,
  progress: (done: number) => void,
) {
  let offset = from;

  while (offset < file.size) {
    const start = offset + LENGTH_BYTES;
    const end = start + (await lengthAt(file, offset));

    if (end > file.size) throw Error("Invalid backup");
    await command("import_backup_part", {
      data: await fileBase64(file.slice(start, end)),
      last: end === file.size,
    });
    offset = end;
    progress(offset / file.size);
  }
}

export async function restoreBackup(
  file: Blob,
  password: string,
  progress: (done: number) => void,
) {
  if (!(await isStreamed(file))) {
    await command("import_backup", { bytes: await fileBase64(file), password });

    return;
  }

  const parts = PRELUDE + (await lengthAt(file, MAGIC.length));
  const header = await fileBase64(file.slice(PRELUDE, parts));

  await command("import_backup_start", { header, password });

  try {
    await restoreParts(file, parts, progress);
  } catch (problem) {
    await command("import_backup_abort").catch(() => {});
    throw problem;
  }
}
