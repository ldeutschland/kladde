import { downloadFile } from "../files/attachments";
import type { ViewerProps } from "./viewing";
import { EditActions, ViewActions } from "./ViewerControls";

interface SessionState {
  editing: boolean;
  history: {
    changed: boolean;
    canRedo: boolean;
    undo: () => void;
    redo: () => void;
  };
  leave: () => Promise<void>;
}

export function ViewerEnd({
  viewer,
  session,
  saving,
  editable,
  edit,
  save,
}: {
  viewer: ViewerProps;
  session: SessionState;
  saving: boolean;
  editable: boolean;
  edit: () => void;
  save: (copy: boolean) => Promise<void>;
}) {
  const { book, entry, target, t } = viewer;
  const { history } = session;

  if (session.editing)
    return (
      <EditActions
        t={t}
        mobile={viewer.mobile}
        saving={saving}
        changed={history.changed}
        canRedo={history.canRedo}
        undo={history.undo}
        redo={history.redo}
        cancel={() => void session.leave()}
        save={(copy) => void save(copy)}
      />
    );

  return (
    <ViewActions
      t={t}
      editable={editable}
      edit={edit}
      download={() =>
        void downloadFile(book, entry, target.url, target.name).catch(() => {})
      }
    />
  );
}
