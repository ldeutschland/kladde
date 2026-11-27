import type { ChromeAction } from "../platform/chrome";
import { usePhoneChrome } from "./usePhoneChrome";
import { useShortcuts } from "./useShortcuts";
import { useStepGestures } from "./useStepGestures";
import type { WorkspaceActions } from "./workspaceActions";
import type { WorkspaceModel } from "./useWorkspaceModel";

export function useWorkspaceInput(
  model: WorkspaceModel,
  actions: WorkspaceActions,
) {
  const { mobile, navigation, overlays } = model;

  useShortcuts({
    tabs: mobile ? null : navigation.tabSet,
    switchTo: navigation.switchTo,
    newTab: () => actions.openTab(null),
    run: (key) => runShortcut(model, actions, key),
  });
  useStepGestures(mobile, {
    can: (direction) =>
      !overlays.modal && !overlays.popup && navigation.canStep(direction),
    go: (direction) =>
      direction < 0 ? navigation.goBack() : navigation.nav(1),
  });
  usePhoneChrome({
    mobile,
    t: model.t,
    tab: navigation.tab,
    page: navigation.page,
    theme: model.theme,
    dark: model.dark,
    behind: navigation.behind,
    ai: model.ai.entry,
    nativeChrome: model.nativeChrome,
    setNativeChrome: model.setNativeChrome,
    act: (action) => runChromeAction(model, actions, action),
    back: navigation.goBack,
  });
}

function runShortcut(
  model: WorkspaceModel,
  actions: WorkspaceActions,
  key: string,
) {
  if (key === "p" || key === "k") actions.showSearch();
  if (key === "f") actions.findInPage();
  if (key === "n") actions.create();
  if (key === "[") model.navigation.nav(-1);
  if (key === "]") model.navigation.nav(1);
  if (key === "\\") model.setSide(!model.side);
  if (key === "l")
    model.book.settings.set("theme", model.dark ? "light" : "dark");
  if (key === "j" && model.ai.policy.enabled) actions.toggleAi();
}

function runChromeAction(
  model: WorkspaceModel,
  actions: WorkspaceActions,
  action: ChromeAction,
) {
  const { book, navigation, overlays } = model;
  const page = navigation.page;

  if (action === "home" || action === "pages") navigation.showTab(action);
  if (action === "search") actions.showSearch();
  if (action === "ai" && model.ai.entry) actions.openAi();
  if (action === "back") navigation.goBack();
  if (action === "settings") overlays.setModal("settings");
  if (action === "add") overlays.showSheet("add", book.id);
  if (action === "more" && page) overlays.showSheet("page", page.id);
  if (action === "favorite" && page)
    void book.change(page.id, { favorite: !page.favorite });
}
