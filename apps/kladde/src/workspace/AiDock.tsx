import { Suspense } from "react";
import { Sparkles } from "lucide-react";
import { AgentPanel } from "./lazyParts";
import type { WorkspaceScope } from "./useWorkspaceViews";

export function AiDock({ workspace }: { workspace: WorkspaceScope }) {
  const { ai, t } = workspace;

  if (ai.open) return <DockedAgentPanel workspace={workspace} />;
  if (workspace.mobile || !ai.policy.enabled) return null;

  return (
    <button
      className="aifab"
      aria-label={t("ai")}
      title={t("askAiShort") + " (⌘J)"}
      onClick={() => workspace.openAi()}
    >
      <Sparkles />
    </button>
  );
}

function DockedAgentPanel({ workspace }: { workspace: WorkspaceScope }) {
  const { ai, book, editor } = workspace;

  return (
    <Suspense fallback={null}>
      <AgentPanel
        key={book.id}
        book={book}
        current={workspace.navigation.entry}
        editor={() => editor.editor.current}
        policy={ai.policy}
        setPolicy={ai.setPolicy}
        local={ai.local}
        view={ai.view}
        setView={ai.setView}
        prompt={ai.prompt}
        clearPrompt={ai.clearPrompt}
        open={workspace.openFromAi}
        openSource={workspace.openSource}
        close={ai.close}
        ask={workspace.ask}
        t={workspace.t}
        lang={workspace.lang}
      />
    </Suspense>
  );
}
