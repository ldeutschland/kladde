import { useEffect, useState } from "react";
import {
  loadFrimousseData,
  searchEmojis,
  type FrimousseEmoji,
  type FrimousseEmojiData,
} from "@blocknote/core/emoji-data";
import { Shuffle, Trash2, Upload } from "lucide-react";
import type { T } from "../locale/locale";

const newestSupportedVersion = 15;
const QUERY_LENGTH = 60;
const SEARCH_RESULTS = 240;
const IMAGE_TYPES = "image/png,image/jpeg,image/gif,image/webp";

type Choose = (emoji: string) => void;

interface PickerBarProps {
  query: string;
  setQuery: (query: string) => void;
  usable: FrimousseEmoji[];
  t: T;
  choose: Choose;
  upload: (file: File | undefined) => void;
  remove?: () => void;
}

function useEmojiData(lang: string) {
  const [data, setData] = useState<FrimousseEmojiData | null>(null);

  useEffect(() => {
    let current = true;

    void loadFrimousseData(lang === "en" ? "en" : "de").then((loaded) => {
      if (current) setData(loaded);
    });

    return () => {
      current = false;
    };
  }, [lang]);

  return data;
}

function randomEmoji(usable: FrimousseEmoji[]) {
  return usable[Math.floor(Math.random() * usable.length)].emoji;
}

function EmojiButton({
  emoji,
  choose,
}: {
  emoji: FrimousseEmoji;
  choose: Choose;
}) {
  return (
    <button
      aria-label={emoji.label}
      title={emoji.label}
      onClick={() => choose(emoji.emoji)}
    >
      {emoji.emoji}
    </button>
  );
}

function PickerBar({
  query,
  setQuery,
  usable,
  t,
  choose,
  upload,
  remove,
}: PickerBarProps) {
  return (
    <div className="pickerbar">
      <input
        autoFocus
        aria-label={t("filterEmoji")}
        placeholder={t("filterEmoji")}
        value={query}
        onChange={(event) =>
          setQuery(event.target.value.slice(0, QUERY_LENGTH))
        }
      />
      <button
        aria-label={t("random")}
        title={t("random")}
        disabled={!usable.length}
        onClick={() => choose(randomEmoji(usable))}
      >
        <Shuffle />
      </button>
      <label className="iconbutton" title={t("upload")}>
        <Upload />
        <span className="hidden">{t("upload")}</span>
        <input
          className="hidden"
          type="file"
          accept={IMAGE_TYPES}
          onChange={(event) => upload(event.target.files?.[0])}
        />
      </label>
      {remove && (
        <button aria-label={t("remove")} title={t("remove")} onClick={remove}>
          <Trash2 />
        </button>
      )}
    </div>
  );
}

function EmojiList({
  data,
  query,
  usable,
  choose,
}: {
  data: FrimousseEmojiData;
  query: string;
  usable: FrimousseEmoji[];
  choose: Choose;
}) {
  if (query)
    return (
      <div className="emojigrid">
        {searchEmojis(usable, query, data.locale)
          .slice(0, SEARCH_RESULTS)
          .map((emoji) => (
            <EmojiButton key={emoji.emoji} emoji={emoji} choose={choose} />
          ))}
      </div>
    );

  return data.categories.map((category) => (
    <section key={category.index}>
      <h4>{category.label}</h4>
      <div className="emojigrid">
        {usable
          .filter((emoji) => emoji.category === category.index)
          .map((emoji) => (
            <EmojiButton key={emoji.emoji} emoji={emoji} choose={choose} />
          ))}
      </div>
    </section>
  ));
}

export function EmojiPicker({
  lang,
  t,
  choose,
  upload,
  remove,
}: {
  lang: string;
  t: T;
  choose: Choose;
  upload: (file: File | undefined) => void;
  remove?: () => void;
}) {
  const data = useEmojiData(lang);
  const [query, setQuery] = useState("");
  const usable = (data?.emojis ?? []).filter(
    (emoji) => emoji.version <= newestSupportedVersion,
  );

  return (
    <div className="emojipicker">
      <PickerBar
        query={query}
        setQuery={setQuery}
        usable={usable}
        t={t}
        choose={choose}
        upload={upload}
        remove={remove}
      />
      <div className="emojiscroll">
        {data ? (
          <EmojiList
            data={data}
            query={query}
            usable={usable}
            choose={choose}
          />
        ) : (
          <p className="muted">…</p>
        )}
      </div>
    </div>
  );
}
