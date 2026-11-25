import type { Entry, Page } from "../notebook/notebook";
import { FindBar } from "../search/FindBar";
import { DesktopHeader, PhoneHeader } from "./Headers";
import { HomeContent, RootView } from "./HomeView";
import { PageView } from "./PageView";
import { PagesContent } from "./Sidebar";
import { TabBar } from "./TabBar";
import type { WorkspaceScope } from "./useWorkspaceViews";

export function WorkArea({ workspace }: { workspace: WorkspaceScope }) {
  const { page, entry } = workspace.navigation;

  return (
    <section className="work">
      {!workspace.mobile && <WorkTabs workspace={workspace} />}
      <WorkHeader workspace={workspace} />
      {page && entry ? (
        <OpenPage workspace={workspace} page={page} entry={entry} />
      ) : (
        <RootContent workspace={workspace} />
      )}
    </section>
  );
}

function WorkTabs({ workspace }: { workspace: WorkspaceScope }) {
  const { navigation } = workspace;

  return (
    <TabBar
      book={workspace.book}
      t={workspace.t}
      current={navigation.id}
      reachable={navigation.reachable}
      controls={{
        tabs: navigation.tabSet,
        setTabs: navigation.setTabSet,
        switchTo: navigation.switchTo,
      }}
      openTab={workspace.openTab}
      drop={workspace.drops.tabs}
    />
  );
}

function WorkHeader({ workspace }: { workspace: WorkspaceScope }) {
  const { book, t, overlays, navigation } = workspace;

  if (workspace.mobile)
    return (
      <PhoneHeader
        book={book}
        page={navigation.page}
        t={t}
        back={navigation.goBack}
        more={(shown) => overlays.showSheet("page", shown.id)}
        settings={() => overlays.setModal("settings")}
      />
    );

  return (
    <DesktopHeader
      book={book}
      page={navigation.page}
      t={t}
      lang={workspace.lang}
      link={workspace.link}
      drops={workspace.drops}
      side={workspace.side}
      showSide={() => workspace.setSide(true)}
      nav={navigation.nav}
      more={(shown, e) => overlays.showPopup("page", shown.id, e)}
    />
  );
}

function OpenPage({
  workspace,
  page,
  entry,
}: {
  workspace: WorkspaceScope;
  page: Page;
  entry: Entry;
}) {
  const { navigation, coverTools, setCoverTools, finding } = workspace;

  return (
    <>
      {finding.page === page.id && (
        <FindBar
          root={navigation.view}
          finding={finding}
          setQuery={(query) =>
            workspace.setFinding((current) => ({ ...current, query }))
          }
          t={workspace.t}
          close={workspace.closeFind}
        />
      )}
      <PageView
        key={page.id}
        book={workspace.book}
        entry={entry}
        page={page}
        all={workspace.all}
        database={workspace.database}
        backlinks={workspace.links}
        viewRef={navigation.view}
        tab={navigation.tab}
        small={workspace.small}
        coverTools={coverTools === page.id}
        toggleCoverTools={() =>
          setCoverTools(coverTools === page.id ? null : page.id)
        }
        showMenu={workspace.overlays.showPopup}
        link={workspace.link}
        drops={workspace.drops}
        editor={workspace.editor}
        setup={workspace.setup}
        dbProps={workspace.dbProps}
        openPage={navigation.open}
      />
    </>
  );
}

function RootContent({ workspace }: { workspace: WorkspaceScope }) {
  const { navigation, pagesShown } = workspace;

  return (
    <RootView
      viewRef={navigation.view}
      tab={navigation.tab}
      pagesShown={pagesShown}
      t={workspace.t}
      drop={workspace.drops.home}
    >
      {pagesShown ? (
        <PagesList workspace={workspace} />
      ) : (
        <Home workspace={workspace} />
      )}
    </RootView>
  );
}

function PagesList({ workspace }: { workspace: WorkspaceScope }) {
  return (
    <PagesContent
      parts={workspace.railParts}
      t={workspace.t}
      shared={workspace.shared.length}
      capture={workspace.quick.capture}
      settings={() => workspace.overlays.setModal("settings")}
    />
  );
}

function Home({ workspace }: { workspace: WorkspaceScope }) {
  const { ai } = workspace;

  return (
    <HomeContent
      book={workspace.book}
      all={workspace.all}
      t={workspace.t}
      lang={workspace.lang}
      mobile={workspace.mobile}
      link={workspace.link}
      shared={workspace.shared.length}
      askReady={ai.askReady}
      setAskReady={ai.setAskReady}
      askAi={(text) => workspace.openAi("chat", text)}
      actions={workspace.quick}
    />
  );
}
