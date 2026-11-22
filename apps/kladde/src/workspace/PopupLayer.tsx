import type { Notebook, Page } from "../notebook/notebook";
import type { T } from "../locale/locale";
import type { AiRole } from "../ai/aiPages";
import type { QuickActions } from "./HomeView";
import { PageMenu, type PageMenuActions } from "./PageMenu";
import {
  AddMenu,
  AiRoleMenu,
  BooksMenu,
  CoverPopover,
  IconPopover,
  RenamePopover,
} from "./Popovers";
import type { ImageKey, Popup } from "./types";

export interface PopupActions {
  close: () => void;
  page: PageMenuActions;
  add: QuickActions;
  chooseRole: (page: Page, role: AiRole | null) => void;
  upload: (key: ImageKey, target: string, file: File | undefined) => void;
  switchBook: (id: string) => void;
  newBook: () => void;
}

export function PopupLayer({
  popup,
  book,
  books,
  current,
  t,
  lang,
  mobile,
  shared,
  actions,
}: {
  popup: Popup;
  book: Notebook;
  books: [string, string][];
  current: string | null;
  t: T;
  lang: string;
  mobile: boolean;
  shared: number;
  actions: PopupActions;
}) {
  if (!popup) return null;
  const base = { anchor: popup.anchor, t, close: actions.close };
  const page = book.pages.get(popup.id);

  if (popup.kind === "add")
    return (
      <AddMenu
        {...base}
        mobile={mobile}
        shared={shared}
        actions={actions.add}
      />
    );
  if (popup.kind === "books")
    return (
      <BooksMenu
        {...base}
        books={books}
        current={book.id}
        switchBook={actions.switchBook}
        newBook={actions.newBook}
      />
    );
  if (!page) return null;
  const withPage = { ...base, book, page };

  if (popup.kind === "page")
    return (
      <PageMenu
        {...withPage}
        current={page.id === current}
        lang={lang}
        mobile={mobile}
        actions={actions.page}
      />
    );
  if (popup.kind === "ai")
    return (
      <AiRoleMenu
        {...withPage}
        choose={(role) => actions.chooseRole(page, role)}
      />
    );
  if (popup.kind === "rename") return <RenamePopover {...withPage} />;
  if (popup.kind === "icon")
    return <IconPopover {...withPage} lang={lang} upload={actions.upload} />;

  return <CoverPopover {...withPage} upload={actions.upload} />;
}
