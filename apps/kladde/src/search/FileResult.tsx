import { useEffect, useState } from "react";
import {
  File,
  FileArchive,
  FileImage,
  FileSpreadsheet,
  FileText,
  Presentation,
  type LucideIcon,
} from "lucide-react";
import { Highlight } from "./Highlight";
import { command } from "../platform/native";
import type { SearchHit } from "./search";
import type { T } from "../locale/locale";

type Preview = [pages: number, jpeg: string] | null;

const CACHE_LIMIT = 200;
const thumbnails = new Map<string, Promise<Preview>>();
const ICONS: [RegExp, LucideIcon][] = [
  [/\.(png|jpe?g|gif|webp|avif|heic|heif|tiff?|bmp|svg)$/i, FileImage],
  [/\.(xlsx?|csv|tsv|numbers|ods)$/i, FileSpreadsheet],
  [/\.(pptx?|key|odp)$/i, Presentation],
  [/\.(zip|tar|gz|7z|rar)$/i, FileArchive],
  [/\.(pdf|docx?|txt|md|rtf|pages|odt)$/i, FileText],
];

function thumbnail(space: string, doc: string, file: string) {
  const key = space + ":" + file;
  const known = thumbnails.get(key);

  if (known) return known;
  const request = { space, doc, file };
  const loading = command<Preview>("attachment_thumbnail", request).catch(
    () => {
      thumbnails.delete(key);

      return null;
    },
  );

  thumbnails.set(key, loading);
  const oldest = thumbnails.keys().next().value;

  if (thumbnails.size > CACHE_LIMIT && oldest) thumbnails.delete(oldest);

  return loading;
}

function useThumbnail(space: string, doc: string, file: string) {
  const [preview, setPreview] = useState<Preview>(null);

  useEffect(() => {
    let current = true;

    setPreview(null);
    void thumbnail(space, doc, file).then((loaded) => {
      if (current) setPreview(loaded);
    });

    return () => {
      current = false;
    };
  }, [space, doc, file]);

  return preview;
}

function fileType(name: string) {
  return /\.([a-z0-9]{1,5})$/i.exec(name)?.[1].toUpperCase() ?? "";
}

function FileThumb({ preview, name }: { preview: Preview; name: string }) {
  if (preview)
    return (
      <span className="filethumb" aria-hidden="true">
        <img
          src={"data:image/jpeg;base64," + preview[1]}
          alt=""
          draggable={false}
        />
      </span>
    );
  const Icon = ICONS.find(([pattern]) => pattern.test(name))?.[1] ?? File;

  return (
    <span className="filethumb" aria-hidden="true">
      <Icon />
      <small>{fileType(name)}</small>
    </span>
  );
}

function placeOf(hit: SearchHit, preview: Preview, t: T) {
  const pages = preview?.[0] ?? 0;

  if (hit.snippet && (hit.page || pages > 1))
    return t("filePageNumber").replace("{page}", String((hit.page ?? 0) + 1));
  if (!hit.snippet && pages > 1)
    return t("filePageCount").replace("{count}", String(pages));

  return "";
}

export function FileResult({
  space,
  hit,
  query,
  t,
  open,
}: {
  space: string;
  hit: SearchHit;
  query: string;
  t: T;
  open: () => void;
}) {
  const preview = useThumbnail(space, hit.doc, hit.file ?? "");
  const name = hit.name || t("file");
  const place = placeOf(hit, preview, t);
  const snippet = hit.snippet.replace(/\s+/g, " ").trim();

  return (
    <button className="file-result" onClick={open}>
      <FileThumb preview={preview} name={name} />
      <span className="grow searchhit">
        <span>
          <Highlight text={name} query={query} />
        </span>
        {(place || snippet) && (
          <small>
            {place}
            {place && snippet && " · "}
            <Highlight text={snippet} query={query} />
          </small>
        )}
      </span>
    </button>
  );
}
