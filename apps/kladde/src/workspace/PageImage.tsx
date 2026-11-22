import { useState, useEffect } from "react";
import { localFile } from "../files/attachments";
import type { Entry, Notebook } from "../notebook/notebook";

export function PageImage({
  book,
  entry,
  reference,
  cover = false,
}: {
  book: Notebook;
  entry: Entry;
  reference: string;
  cover?: boolean;
}) {
  const [url, setUrl] = useState("");

  useEffect(() => {
    let cancelled = false,
      loaded = "";

    setUrl("");
    void localFile(book, entry, reference)
      .then((value) => {
        loaded = value;

        if (cancelled) {
          if (value) URL.revokeObjectURL(value);

          return;
        }

        setUrl(value);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (loaded) URL.revokeObjectURL(loaded);
    };
  }, [book, entry, reference]);

  return url ? (
    <img className={cover ? "coverimage" : "iconimage"} src={url} alt="" />
  ) : null;
}
