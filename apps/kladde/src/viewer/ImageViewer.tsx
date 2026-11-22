import { Crop, FlipHorizontal2, RotateCcw, RotateCw } from "lucide-react";
import type { ImageDraft } from "./imageExport";
import { flipped, rotated } from "./marks";
import { FoundMarks, useFoundBoxes } from "./foundMarks";
import type { T } from "../locale/locale";
import { fileId, type ViewerProps } from "./viewing";
import { Sheet } from "./Sheet";
import { CropActions, CropFrame } from "./CropFrame";
import { BLANK, imageLayout } from "./imageLayout";
import { saveImage } from "./saveImage";
import { useImageCrop } from "./useImageCrop";
import { useLoadedImage } from "./useLoadedImage";
import { useEditSave } from "./useEditSave";
import { useEditSession } from "./useEditSession";
import { usePens } from "./usePens";
import { useStage, useStageSize } from "./useStage";
import { useZoom } from "./useZoom";
import { isTyping, viewerKeys } from "./viewerKeys";
import { ViewerFrame } from "./ViewerFrame";
import { ViewerEnd } from "./ViewerEnd";
import { IconButton, MarkTools, ZoomControls } from "./ViewerControls";

type DraftUpdate = (draft: ImageDraft) => ImageDraft;

function ImageTools({
  t,
  crop,
  commit,
}: {
  t: T;
  crop: () => void;
  commit: (update: DraftUpdate) => void;
}) {
  const turn = (by: 90 | -90) =>
    commit((draft) => ({ ...draft, turn: rotated(draft.turn, by) }));

  return (
    <span className="viewergroup">
      <IconButton label={t("toolCrop")} icon={<Crop />} onClick={crop} />
      <IconButton
        label={t("rotateLeft")}
        icon={<RotateCcw />}
        onClick={() => turn(-90)}
      />
      <IconButton
        label={t("rotateRight")}
        icon={<RotateCw />}
        onClick={() => turn(90)}
      />
      <IconButton
        label={t("flipImage")}
        icon={<FlipHorizontal2 />}
        onClick={() =>
          commit((draft) => ({ ...draft, ...flipped(draft.turn, draft.flip) }))
        }
      />
    </span>
  );
}

function useImageViewer(props: ViewerProps) {
  const { book, entry, target, t, mobile } = props;
  const stage = useStage();
  const size = useStageSize(stage.element);
  const zoom = useZoom(stage);
  const pens = usePens(mobile ? "hand" : "pen");
  const session = useEditSession<ImageDraft>(
    BLANK,
    !!target.edit,
    props.close,
    t,
  );
  const image = useLoadedImage(props);
  const found = useFoundBoxes(
    { space: book.id, doc: entry.id, file: fileId(target.url) },
    target.page ?? 0,
    target.found,
  );
  const crop = useImageCrop();
  const saver = useEditSave(props, (copy) =>
    saveImage(props, image!.element, session.history.state, copy),
  );
  const draft = session.editing ? session.history.state : BLANK;
  const layout = imageLayout({
    image: image?.element,
    draft,
    cropping: !!crop.frame,
    stage: size,
    zoom: zoom.zoom,
    mobile,
  });

  return {
    stage,
    zoom,
    pens,
    session,
    image,
    found,
    crop,
    saver,
    draft,
    layout,
  };
}

type ImageViewerState = ReturnType<typeof useImageViewer>;

function ImageStage({
  viewer,
  title,
  t,
}: {
  viewer: ImageViewerState;
  title: string;
  t: T;
}) {
  const { stage, zoom, pens, session, image, crop, draft, layout } = viewer;
  const { history, editing } = session;
  const { width, height, scale } = layout;

  return (
    <div
      className="viewerpaper"
      style={{ padding: layout.padding }}
      onDoubleClick={(event) =>
        !editing && zoom.toggle(event.clientX, event.clientY)
      }
    >
      {image ? (
        <Sheet
          width={width}
          height={height}
          turn={draft.turn}
          flip={draft.flip}
          view={layout.box}
          scale={scale}
          href={image.url}
          marks={draft.marks}
          tool={editing ? (crop.frame ? "crop" : pens.tool) : null}
          pen={pens.penFor(width, height)}
          change={
            editing
              ? (marks) => history.commit((current) => ({ ...current, marks }))
              : undefined
          }
          label={title}
        >
          {crop.frame && (
            <CropFrame
              frame={crop.frame}
              bounds={layout.whole}
              scale={scale}
              change={crop.setFrame}
            />
          )}
          {!editing && (
            <FoundMarks
              boxes={viewer.found}
              width={width}
              height={height}
              stage={stage.ref}
            />
          )}
        </Sheet>
      ) : (
        <p className="viewernote" role="status">
          {t(image === undefined ? "previewLoading" : "noFilePreview")}
        </p>
      )}
    </div>
  );
}

export function ImageViewer(props: ViewerProps) {
  const { target, t, mobile } = props;
  const viewer = useImageViewer(props);
  const { stage, zoom, pens, session, image, crop, draft, layout } = viewer;
  const { history, editing } = session;
  const title = target.name || t("image");

  function escape() {
    if (crop.frame) crop.cancel();
    else if (isTyping()) return;
    else if (editing) void session.leave();
    else props.close();
  }

  const tools = crop.frame ? (
    <CropActions
      t={t}
      apply={() => crop.apply(history, layout)}
      reset={() => crop.setFrame(layout.whole)}
      cancel={crop.cancel}
    />
  ) : (
    <MarkTools
      pens={pens}
      t={t}
      extra={
        <ImageTools
          t={t}
          crop={() => crop.start(draft, layout)}
          commit={history.commit}
        />
      }
    />
  );

  return (
    <ViewerFrame
      title={title}
      close={() => void session.requestClose()}
      escape={escape}
      t={t}
      stage={stage.attach}
      keys={(event) => viewerKeys(event, zoom, editing, history)}
      center={!mobile && image && <ZoomControls zoom={zoom} t={t} />}
      end={
        <ViewerEnd
          viewer={props}
          session={session}
          saving={viewer.saver.saving}
          editable={!!image}
          edit={() => session.start(BLANK)}
          save={async (copy) => {
            if (image) await viewer.saver.save(copy);
          }}
        />
      }
      tools={editing && image ? tools : undefined}
    >
      <ImageStage viewer={viewer} title={title} t={t} />
      {session.asking}
    </ViewerFrame>
  );
}
