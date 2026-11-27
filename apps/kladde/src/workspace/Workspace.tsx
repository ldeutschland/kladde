import { AiSwitch } from "../ai/aiSwitch";
import { ContextMenuHost } from "../ui/ContextMenu";
import { AiDock } from "./AiDock";
import { BottomNav } from "./BottomNav";
import { FloatingLayers } from "./FloatingLayers";
import { Sidebar } from "./Sidebar";
import { ToastArea } from "./Toasts";
import { useWorkspaceInput } from "./useWorkspaceInput";
import { useWorkspaceModel, type WorkspaceProps } from "./useWorkspaceModel";
import { useWorkspaceViews, type WorkspaceScope } from "./useWorkspaceViews";
import { WorkArea } from "./WorkArea";
import { createWorkspaceActions } from "./workspaceActions";
import { WorkspaceModals } from "./WorkspaceModals";
import { WorkspacePopups } from "./WorkspacePopups";

export function Workspace(props: WorkspaceProps) {
  const model = useWorkspaceModel(props);
  const actions = createWorkspaceActions(model);

  useWorkspaceInput(model, actions);
  const views = useWorkspaceViews(model, actions);
  const workspace: WorkspaceScope = { ...model, ...actions, ...views };

  return (
    <AiSwitch value={workspace.ai.policy.enabled}>
      <main className={shellClassName(workspace)}>
        {workspace.side && !workspace.mobile && (
          <WorkspaceSidebar workspace={workspace} />
        )}
        <WorkArea workspace={workspace} />
        <AiDock workspace={workspace} />
        {workspace.mobile && <PhoneNavigation workspace={workspace} />}
        <ToastArea toasts={workspace.toasts} t={workspace.t} />
        <WorkspacePopups workspace={workspace} />
        <WorkspaceModals workspace={workspace} />
        <FloatingLayers workspace={workspace} />
        {workspace.askUI}
        <ContextMenuHost t={workspace.t} />
      </main>
    </AiSwitch>
  );
}

function shellClassName(workspace: WorkspaceScope) {
  const device = workspace.mobile ? "phone" : "desktop";
  const chrome = workspace.nativeChrome ? " native" : "";

  return "shell " + device + chrome;
}

function WorkspaceSidebar({ workspace }: { workspace: WorkspaceScope }) {
  const { overlays, quick } = workspace;

  return (
    <Sidebar
      parts={workspace.railParts}
      t={workspace.t}
      rail={workspace.rail}
      setRail={workspace.setRail}
      shared={workspace.shared.length}
      homeShown={!workspace.navigation.page && !overlays.modal}
      aiOpen={workspace.ai.open}
      actions={{
        hide: () => workspace.setSide(false),
        create: quick.page,
        search: workspace.showSearch,
        home: () => void workspace.navigation.open(null),
        toggleAi: workspace.toggleAi,
        capture: quick.capture,
        clipWeb: workspace.clipWeb,
        settings: () => overlays.setModal("settings"),
      }}
    />
  );
}

function PhoneNavigation({ workspace }: { workspace: WorkspaceScope }) {
  const { navigation, overlays } = workspace;

  return (
    <BottomNav
      t={workspace.t}
      tab={navigation.tab}
      showTab={navigation.showTab}
      search={workspace.showSearch}
      ai={() => workspace.openAi()}
      aiShown={workspace.ai.entry}
      add={(e) => overlays.showPopup("add", workspace.book.id, e)}
    />
  );
}
