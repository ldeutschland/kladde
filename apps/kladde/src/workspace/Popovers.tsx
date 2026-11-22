import { Suspense } from "react";
import {
  Camera,
  Check,
  FilePlus,
  Mic,
  Plus,
  Scissors,
  SquarePen,
  Table2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { Notebook, Page } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { Popover, listKeys } from "../ui/dialog";
import { PageIcon } from "./tree";
import { AI_ROLES, ROLE_LABELS, pageRole, type AiRole } from "../ai/aiPages";
import { ROLE_ICONS } from "../agentPanel/AiLibrary";
import { COVER_TONES, IMAGE_TYPES, firstLetter } from "./commands";
import { EmojiPicker } from "./lazyParts";
import type { QuickActions } from "./HomeView";
import type { ImageKey } from "./types";

interface PopoverBase {
  anchor: DOMRect;
  t: T;
  close: () => void;
}

export function AddMenu({
  anchor,
  t,
  close,
  mobile,
  shared,
  actions,
}: PopoverBase & {
  mobile: boolean;
  shared: number;
  actions: QuickActions;
}) {
  const closing = (run: () => void) => () => {
    close();
    run();
  };

  return (
    <Popover anchor={anchor} label={t("createNew")} close={close}>
      <div className="menu" onKeyDown={listKeys}>
        <button onClick={actions.page}>
          <FilePlus />
          {t("newPage")}
        </button>
        <button onClick={closing(actions.capture)}>
          <SquarePen />
          <span className="grow">{t("quickNote")}</span>
          {shared > 0 && <small>{shared}</small>}
        </button>
        <button onClick={closing(actions.voice)}>
          <Mic />
          {t("voiceNote")}
        </button>
        <button onClick={actions.database}>
          <Table2 />
          {t("newDb")}
        </button>
        <button onClick={closing(actions.clipWeb)}>
          <Scissors />
          {t("webClip")}
        </button>
        {mobile && (
          <button onClick={closing(actions.photo)}>
            <Camera />
            {t("photo")}
          </button>
        )}
      </div>
    </Popover>
  );
}

export function AiRoleMenu({
  anchor,
  t,
  close,
  book,
  page,
  choose,
}: PopoverBase & {
  book: Notebook;
  page: Page;
  choose: (role: AiRole | null) => void;
}) {
  const current = pageRole(book, page);

  return (
    <Popover anchor={anchor} label={t("aiUseAs")} close={close}>
      <div className="menu" role="menu" onKeyDown={listKeys}>
        {[null, ...AI_ROLES].map((role) => {
          const Icon = role ? ROLE_ICONS[role] : X;
          const chosen = current === role;

          return (
            <button
              key={role ?? "none"}
              role="menuitemradio"
              aria-checked={chosen}
              autoFocus={chosen}
              onClick={() => choose(role)}
            >
              <Icon />
              <span className="grow">
                {t(role ? ROLE_LABELS[role] : "aiRoleNone")}
              </span>
              {chosen && <Check />}
            </button>
          );
        })}
      </div>
    </Popover>
  );
}

export function RenamePopover({
  anchor,
  t,
  close,
  book,
  page,
}: PopoverBase & { book: Notebook; page: Page }) {
  return (
    <Popover anchor={anchor} label={t("rename")} close={close} width={320}>
      <form
        className="renameform"
        onSubmit={(e) => {
          e.preventDefault();
          close();
        }}
      >
        <PageIcon page={page} />
        <input
          aria-label={t("rename")}
          placeholder={t("untitled")}
          maxLength={200}
          autoFocus
          defaultValue={page.title}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => void book.change(page.id, { title: e.target.value })}
        />
      </form>
    </Popover>
  );
}

export function IconPopover({
  anchor,
  t,
  close,
  book,
  page,
  lang,
  upload,
}: PopoverBase & {
  book: Notebook;
  page: Page;
  lang: string;
  upload: (key: ImageKey, target: string, file: File | undefined) => void;
}) {
  return (
    <Popover anchor={anchor} label={t("icon")} close={close} width={360}>
      <Suspense fallback={null}>
        <EmojiPicker
          lang={lang}
          t={t}
          choose={(icon) => {
            void book.change(page.id, { icon });
            close();
          }}
          upload={(file) => upload("icon", page.id, file)}
          remove={() => {
            void book.change(page.id, { icon: "" });
            close();
          }}
        />
      </Suspense>
    </Popover>
  );
}

export function CoverPopover({
  anchor,
  t,
  close,
  book,
  page,
  upload,
}: PopoverBase & {
  book: Notebook;
  page: Page;
  upload: (key: ImageKey, target: string, file: File | undefined) => void;
}) {
  const setCover = (cover: string) => {
    void book.change(page.id, { cover });
    close();
  };

  return (
    <Popover anchor={anchor} label={t("cover")} close={close} width={300}>
      <div className="swatches">
        {COVER_TONES.map((tone, index) => (
          <button
            key={tone}
            className="swatch"
            data-tone={tone}
            aria-label={t("cover") + " " + (index + 1)}
            aria-pressed={page.cover === tone}
            onClick={() => setCover(tone)}
          />
        ))}
      </div>
      <div className="menu">
        <label className="menuitem">
          <Upload />
          {t("upload")}
          <input
            className="hidden"
            type="file"
            accept={IMAGE_TYPES.join(",")}
            onChange={(e) => upload("cover", page.id, e.target.files?.[0])}
          />
        </label>
        <button onClick={() => setCover("")}>
          <Trash2 />
          {t("remove")}
        </button>
      </div>
    </Popover>
  );
}

export function BooksMenu({
  anchor,
  t,
  close,
  books,
  current,
  switchBook,
  newBook,
}: PopoverBase & {
  books: [string, string][];
  current: string;
  switchBook: (id: string) => void;
  newBook: () => void;
}) {
  return (
    <Popover anchor={anchor} label={t("workspace")} close={close}>
      <div className="menu" onKeyDown={listKeys}>
        {books.map(([key, name]) => (
          <button key={key} onClick={() => switchBook(key)}>
            <span className="avatar">{firstLetter(name)}</span>
            <span className="grow">{name}</span>
            {key === current && <Check />}
          </button>
        ))}
        <hr />
        <button onClick={newBook}>
          <Plus />
          {t("newBook")}
        </button>
      </div>
    </Popover>
  );
}
