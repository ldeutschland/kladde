import type { Page } from "../notebook/notebook";
import type { T } from "../locale/locale";
import { PageIcon } from "./tree";
import { startPageDrag } from "../ui/dragDrop";
import type { PageLink } from "./types";

export function wantsNewTab(e: { metaKey: boolean; ctrlKey: boolean }) {
  return e.metaKey || e.ctrlKey;
}

export function PageButton({
  page,
  link,
  t,
  className = "pageitem",
}: {
  page: Page;
  link: PageLink;
  t: T;
  className?: string;
}) {
  return (
    <button
      className={className}
      data-current={page.id === link.current || undefined}
      draggable
      onDragStart={(e) => startPageDrag(e, page, page.title || t("untitled"))}
      onClick={(e) => link.go(page.id, wantsNewTab(e))}
      onAuxClick={(e) => {
        if (e.button === 1) link.go(page.id, true);
      }}
      onContextMenu={link.menu(page.id)}
    >
      <PageIcon page={page} />
      <span>{page.title || t("untitled")}</span>
    </button>
  );
}
