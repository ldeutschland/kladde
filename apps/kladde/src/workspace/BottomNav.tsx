import type { MouseEvent, RefObject } from "react";
import { FileText, House, Plus, Search, Sparkles } from "lucide-react";
import type { T } from "../locale/locale";
import type { RootTab } from "../platform/chrome";
import { useAiOn } from "../ai/aiSwitch";

export function BottomNav({
  t,
  tab,
  showTab,
  search,
  ai,
  add,
}: {
  t: T;
  tab: RootTab;
  showTab: (tab: RootTab) => void;
  search: () => void;
  ai: () => void;
  add: (e: MouseEvent<HTMLElement>) => void;
}) {
  const aiOn = useAiOn();

  return (
    <nav className="bottom" aria-label={t("navigation")}>
      <div className="bottomtabs">
        <button
          data-current={tab === "home" || undefined}
          onClick={() => showTab("home")}
        >
          <House />
          {t("home")}
        </button>
        <button
          data-current={tab === "pages" || undefined}
          onClick={() => showTab("pages")}
        >
          <FileText />
          {t("pages")}
        </button>
        <button onClick={search}>
          <Search />
          {t("search")}
        </button>
        {aiOn && (
          <button onClick={ai}>
            <Sparkles />
            {t("ai")}
          </button>
        )}
      </div>
      <button className="bottomadd" aria-label={t("createNew")} onClick={add}>
        <Plus />
      </button>
    </nav>
  );
}

export function PhotoInput({
  inputRef,
  picked,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  picked: (file: File) => void;
}) {
  return (
    <input
      ref={inputRef}
      type="file"
      accept="image/*"
      className="hidden"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(e) => {
        const file = e.target.files?.[0];

        e.target.value = "";
        if (!file) return;
        picked(file);
      }}
    />
  );
}
