import type { ComponentProps } from "react";
import { BookMarked, Brain, Plus } from "lucide-react";
import type { Page } from "../notebook/notebook";
import { SortButton, Tree } from "./tree";
import { ensureAiTree } from "../ai/aiPages";
import { useAiOn } from "../ai/aiSwitch";
import { PageButton } from "./PageButton";
import type { PageDrops } from "./usePageDrops";
import type { PageLink } from "./types";

type TreeProps = ComponentProps<typeof Tree>;

export function PageLists({
  tree,
  all,
  link,
  drops,
  aiRoot,
  create,
  openAiHome,
  openAiLibrary,
}: {
  tree: TreeProps;
  all: Page[];
  link: PageLink;
  drops: PageDrops;
  aiRoot: string | null;
  create: () => void;
  openAiHome: () => void;
  openAiLibrary: () => void;
}) {
  const { book, t } = tree;
  const favorites = all.filter((p) => p.favorite && !p.archived);
  const aiOn = useAiOn();

  return (
    <div className="treewrap">
      {favorites.length > 0 && (
        <>
          <div className="sectionhead" {...drops.favorites}>
            <h3>{t("favorites")}</h3>
          </div>
          {favorites.map((p) => (
            <PageButton key={p.id} page={p} link={link} t={t} />
          ))}
        </>
      )}
      <div className="sectionhead" {...drops.root}>
        <h3>{t("pages")}</h3>
        <span className="sectiontools">
          <SortButton book={book} t={t} />
          <button aria-label={t("addPage")} onClick={create}>
            <Plus />
          </button>
        </span>
      </div>
      <Tree {...tree} hidden={aiRoot} />
      <button className="addpage" onClick={create}>
        <Plus />
        {t("addPage")}
      </button>
      {aiOn && (
        <AiPages
          tree={tree}
          aiRoot={aiRoot}
          openAiHome={openAiHome}
          openAiLibrary={openAiLibrary}
        />
      )}
    </div>
  );
}

function AiPages({
  tree,
  aiRoot,
  openAiHome,
  openAiLibrary,
}: {
  tree: TreeProps;
  aiRoot: string | null;
  openAiHome: () => void;
  openAiLibrary: () => void;
}) {
  const { book, t } = tree;

  return (
    <>
      <div className="sectionhead">
        <h3>
          <button className="sectionlink" onClick={openAiHome}>
            {t("aiTree")}
          </button>
        </h3>
        <span className="sectiontools">
          <button
            aria-label={t("aiLibrary")}
            title={t("aiLibrary")}
            onClick={openAiLibrary}
          >
            <BookMarked />
          </button>
        </span>
      </div>
      {aiRoot ? (
        <Tree {...tree} root={aiRoot} />
      ) : (
        <button className="addpage" onClick={() => ensureAiTree(book, t)}>
          <Brain />
          {t("aiTreeCreate")}
        </button>
      )}
    </>
  );
}
