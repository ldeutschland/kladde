import { useEffect, useState } from "react";
import { localFile } from "../files/attachments";
import type { ViewerProps } from "./viewing";

export function useLoadedImage(props: ViewerProps) {
  const { book, entry, target } = props;
  const [image, setImage] = useState<{
    element: HTMLImageElement;
    url: string;
  } | null>();

  useEffect(() => {
    let current = true,
      made = "";

    void localFile(book, entry, target.url)
      .then(async (url) => {
        made = url;
        if (!url) throw Error("Unavailable");
        const element = new Image();

        element.src = url;
        await element.decode();
        if (current) setImage({ element, url });
      })
      .catch(() => current && setImage(null));

    return () => {
      current = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [book, entry, target.url]);

  return image;
}
