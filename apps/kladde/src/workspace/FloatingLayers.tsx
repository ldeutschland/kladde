import { PhotoInput } from "./BottomNav";
import { MovePalette } from "./Palettes";
import { RowPeek } from "./RowPeek";
import type { WorkspaceScope } from "./useWorkspaceViews";

export function FloatingLayers({ workspace }: { workspace: WorkspaceScope }) {
  const { overlays } = workspace;

  return (
    <>
      <MovingPagePalette workspace={workspace} />
      <OpenRowPeek workspace={workspace} />
      <PhotoInput
        inputRef={workspace.photoPicker}
        picked={(file) => {
          overlays.setPhoto(file);
          overlays.setModal("capture");
        }}
      />
    </>
  );
}

function MovingPagePalette({ workspace }: { workspace: WorkspaceScope }) {
  const { moving, setMoving } = workspace.overlays;
  const movingPage = moving ? workspace.book.pages.get(moving) : undefined;

  if (!moving || !movingPage) return null;

  return (
    <MovePalette
      key={moving}
      book={workspace.book}
      moving={movingPage}
      t={workspace.t}
      mobile={workspace.mobile}
      moveTo={workspace.moveTo}
      close={() => setMoving(null)}
    />
  );
}

function OpenRowPeek({ workspace }: { workspace: WorkspaceScope }) {
  const { row, setRow } = workspace.overlays;
  const rowPage = row ? workspace.book.pages.get(row.entry.id) : undefined;

  if (!row || !rowPage) return null;

  return (
    <RowPeek
      book={workspace.book}
      row={row}
      page={rowPage}
      t={workspace.t}
      mobile={workspace.mobile}
      go={workspace.go}
      expand={() => void workspace.navigation.open(row.entry.id)}
      setup={{
        ...workspace.setup,
        setupAi: () => {
          setRow(null);
          workspace.openAi("settings");
        },
      }}
      close={() => setRow(null)}
    />
  );
}
