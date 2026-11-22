import type { ViewerProps } from "./viewing";
import { ImageViewer } from "./ImageViewer";
import { PdfViewer } from "./PdfViewer";

export function FileViewer(props: ViewerProps) {
  if (props.target.kind === "pdf")
    return <PdfViewer key={props.target.url} {...props} />;

  return <ImageViewer key={props.target.url} {...props} />;
}
