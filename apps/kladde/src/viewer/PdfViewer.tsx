import { useMemo, useRef, type KeyboardEvent } from "react";
import { useFoundMarks } from "./foundMarks";
import type { PdfInfo } from "./pdfPages";
import type { T } from "../locale/locale";
import { fileId, type ViewerProps } from "./viewing";
import { NO_PAGES, originalPages, type PageDraft } from "./pdfDraft";
import { usePdfInfo } from "./usePdfInfo";
import { useCurrentPage, usePageJump } from "./usePdfScroll";
import { usePageEdits } from "./usePageEdits";
import { useEditSave } from "./useEditSave";
import { useEditSession } from "./useEditSession";
import { usePens } from "./usePens";
import { useStage, useStageSize } from "./useStage";
import { useZoom } from "./useZoom";
import { findShortcut, isTyping, viewerKeys } from "./viewerKeys";
import { shownMarks, useFileFind } from "./useFileFind";
import { FileFindBar } from "./FileFindBar";
import { savePdf } from "./savePdf";
import { ViewerFrame } from "./ViewerFrame";
import { ViewerEnd } from "./ViewerEnd";
import { MarkTools, ZoomControls } from "./ViewerControls";
import { PageActions, Pager, PdfPage, Thumb } from "./PdfPageViews";

const PADDING = 24;
const PHONE_PADDING = 8;
const ARROW_STEPS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };

function usePdfViewer(props: ViewerProps) {
  const { book, entry, target, t, mobile } = props;
  const source = useMemo(
    () => ({ space: book.id, doc: entry.id, file: fileId(target.url) }),
    [book.id, entry.id, target.url],
  );
  const stage = useStage();
  const column = useRef<HTMLDivElement>(null);
  const size = useStageSize(stage.element);
  const zoom = useZoom(stage);
  const pens = usePens(mobile ? "hand" : "pen");
  const info = usePdfInfo(source);
  const foundPage = target.page ?? 0;
  const found = useFoundMarks(source, foundPage, target.found);
  const originals = useMemo(() => originalPages(info), [info]);
  const session = useEditSession<PageDraft[]>(
    NO_PAGES,
    !!target.edit,
    props.close,
    t,
  );
  const { history, editing } = session;
  const saver = useEditSave(props, (copy) =>
    savePdf(props, source, history.state, copy),
  );
  const edits = usePageEdits(history, info, editing);
  const pages = editing ? history.state : originals;
  const current = useCurrentPage(stage.element, column, pages.length);
  const find = useFileFind(source, target.found ?? "", current);
  const padding = mobile ? PHONE_PADDING : PADDING;
  const go = usePageJump({
    stage,
    column,
    padding,
    info,
    stageWidth: size.width,
    startPage: target.page,
  });

  return {
    source,
    stage,
    column,
    size,
    zoom,
    pens,
    info,
    foundPage,
    found,
    originals,
    session,
    saver,
    edits,
    pages,
    current,
    find,
    padding,
    go,
  };
}

type PdfViewerState = ReturnType<typeof usePdfViewer>;

interface PartProps {
  viewer: PdfViewerState;
  info: PdfInfo;
  t: T;
}

function ThumbRail({ viewer, info, t }: PartProps) {
  const side = useRef<HTMLElement>(null);

  return (
    <nav className="viewerside" ref={side} aria-label={t("pages")}>
      {viewer.pages.map((page, index) => (
        <Thumb
          key={page.source}
          source={viewer.source}
          page={page}
          size={info.sizes[page.source]}
          index={index}
          current={index === viewer.current}
          root={side}
          t={t}
          go={viewer.go}
          drag={viewer.edits.dragFor(index)}
        />
      ))}
    </nav>
  );
}

function marksOn(viewer: PdfViewerState, page: number) {
  const revealed = page === viewer.foundPage ? viewer.found : undefined;

  return shownMarks(viewer.find, page, revealed);
}

function PdfColumn({ viewer, info, t }: PartProps) {
  const { pages, edits } = viewer;
  const { editing } = viewer.session;
  const room = Math.max(1, viewer.size.width - 2 * viewer.padding);

  return (
    <div
      className="pdfcolumn"
      ref={viewer.column}
      style={{ padding: viewer.padding }}
    >
      {pages.map((page, index) => (
        <PdfPage
          key={page.source}
          source={viewer.source}
          page={page}
          index={index}
          size={info.sizes[page.source]}
          room={room}
          zoom={viewer.zoom.zoom}
          stage={viewer.stage.ref}
          editing={editing}
          pens={viewer.pens}
          change={edits.changeMarks}
          t={t}
          found={editing ? undefined : marksOn(viewer, page.source)}
        >
          {editing && (
            <PageActions
              index={index}
              count={pages.length}
              t={t}
              turn={edits.turn}
              move={edits.move}
              remove={edits.remove}
            />
          )}
        </PdfPage>
      ))}
    </div>
  );
}

export function PdfViewer(props: ViewerProps) {
  const { t, mobile, target } = props;
  const viewer = usePdfViewer(props);
  const { stage, zoom, pens, info, session, pages, current, go } = viewer;
  const { editing, history } = session;
  const { find } = viewer;

  function escape() {
    if (isTyping()) return;
    if (editing) void session.leave();
    else if (find.open) find.hide();
    else props.close();
  }

  function pageKeys(event: KeyboardEvent<HTMLElement>) {
    if (findShortcut(event, editing || !info, find.show)) return;
    if (viewerKeys(event, zoom, editing, history) || isTyping()) return;
    if (event.metaKey || event.ctrlKey) return;
    const step = ARROW_STEPS[event.key];

    if (!step) return;
    event.preventDefault();
    go(Math.min(pages.length - 1, Math.max(0, current + step)));
  }

  return (
    <ViewerFrame
      title={target.name || t("file")}
      close={() => void session.requestClose()}
      escape={escape}
      t={t}
      stage={stage.attach}
      keys={pageKeys}
      center={
        !mobile && (
          <>
            {info && (
              <Pager t={t} current={current} count={pages.length} go={go} />
            )}
            {info && <ZoomControls zoom={zoom} t={t} />}
          </>
        )
      }
      end={
        <ViewerEnd
          viewer={props}
          session={session}
          saving={viewer.saver.saving}
          editable={!!info?.editable}
          edit={() => session.start(viewer.originals)}
          save={viewer.saver.save}
          find={find.show}
        />
      }
      tools={editing && info ? <MarkTools pens={pens} t={t} /> : undefined}
      find={!editing && info && <FileFindBar find={find} t={t} />}
      side={!mobile && info && <ThumbRail viewer={viewer} info={info} t={t} />}
      footer={
        mobile &&
        info &&
        pages.length > 1 && (
          <div className="viewerpill">
            {current + 1} / {pages.length}
          </div>
        )
      }
    >
      {info ? (
        <PdfColumn viewer={viewer} info={info} t={t} />
      ) : (
        <p className="viewernote" role="status">
          {t(info === undefined ? "previewLoading" : "noFilePreview")}
        </p>
      )}
      {session.asking}
    </ViewerFrame>
  );
}
