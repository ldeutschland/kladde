import { useEffect, useState, type RefObject } from "react";
import { command } from "../platform/native";
import type { Point } from "./marks";

export interface PdfSource {
  space: string;
  doc: string;
  file: string;
}

export interface PdfInfo {
  sizes: Point[];
  editable: boolean;
}

type Preview = [pages: number, jpeg: string] | null;

const CACHE_LIMIT = 24;
const PARALLEL = 2;
const SETTLE_MS = 120;
const NEAR_MARGIN = "150% 0px";
const MAX_SIDE = 100_000;
const JPEG = /^[A-Za-z0-9+/]+=*$/;
const pictures = new Map<string, Promise<string | null>>();
const waiting: (() => void)[] = [];
let running = 0;

async function slot<T>(work: () => Promise<T>) {
  while (running >= PARALLEL) await new Promise<void>((go) => waiting.push(go));
  running++;

  try {
    return await work();
  } finally {
    running--;
    waiting.pop()?.();
  }
}

function pictureOf(preview: Preview) {
  if (!Array.isArray(preview) || typeof preview[1] !== "string") return null;
  if (!JPEG.test(preview[1])) return null;

  return "data:image/jpeg;base64," + preview[1];
}

function remember(key: string, loading: Promise<string | null>) {
  pictures.set(key, loading);
  const oldest = pictures.keys().next().value;

  if (pictures.size > CACHE_LIMIT && oldest) pictures.delete(oldest);

  return loading;
}

function picture(source: PdfSource, index: number, thumb: boolean) {
  const key = [source.space, source.file, index, thumb].join(":");
  const known = pictures.get(key);

  if (known) return known;
  const name = thumb ? "attachment_thumbnail" : "preview_attachment";
  const loading = slot(() => command<Preview>(name, { ...source, index }))
    .then(pictureOf)
    .catch(() => {
      pictures.delete(key);

      return null;
    });

  return remember(key, loading);
}

export function forgetPagePictures() {
  pictures.clear();
}

export function usePagePicture(
  source: PdfSource,
  index: number,
  near: boolean,
  thumb = false,
) {
  const [shown, setShown] = useState<string | null>(null);
  const { space, doc, file } = source;

  useEffect(() => {
    if (!near) {
      setShown(null);

      return;
    }

    let current = true;
    const settle = setTimeout(() => {
      void picture({ space, doc, file }, index, thumb).then((loaded) => {
        if (current) setShown(loaded);
      });
    }, SETTLE_MS);

    return () => {
      current = false;
      clearTimeout(settle);
    };
  }, [space, doc, file, index, near, thumb]);

  return shown;
}

export function useNear(
  element: RefObject<Element | null>,
  root: RefObject<Element | null>,
) {
  const [near, setNear] = useState(false);

  useEffect(() => {
    const target = element.current;

    if (!target) return;
    const observer = new IntersectionObserver(
      ([entry]) => setNear(entry.isIntersecting),
      { root: root.current, rootMargin: NEAR_MARGIN },
    );

    observer.observe(target);

    return () => observer.disconnect();
  }, [element, root]);

  return near;
}

function isSide(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAX_SIDE
  );
}

export async function pdfInfo(source: PdfSource): Promise<PdfInfo> {
  const info = await command<{ sizes?: unknown; editable?: unknown }>(
    "pdf_pages",
    { ...source },
  );
  const sizes = Array.isArray(info?.sizes) ? info.sizes : [];
  const valid = sizes.every(
    (size) =>
      Array.isArray(size) &&
      size.length === 2 &&
      isSide(size[0]) &&
      isSide(size[1]),
  );

  if (!sizes.length || !valid) throw Error("Invalid PDF");

  return { sizes: sizes as Point[], editable: info.editable === true };
}
