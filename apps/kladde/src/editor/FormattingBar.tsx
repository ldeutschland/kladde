import {
  BasicTextStyleButton,
  FormattingToolbar,
  FormattingToolbarController,
  getFormattingToolbarItems,
} from "@blocknote/react";
import { Sparkles } from "lucide-react";
import type { T } from "../locale/locale";
import {
  DownloadFileButton,
  TranscribeButton,
  ViewFileButton,
} from "./FileBlock";

const HIDDEN_TOOLS = new Set([
  "textAlignLeftButton",
  "textAlignCenterButton",
  "textAlignRightButton",
  "nestBlockButton",
  "unnestBlockButton",
]);

function toolbarItems() {
  return getFormattingToolbarItems().flatMap((item) => {
    if (item.key === "fileDownloadButton")
      return [
        <ViewFileButton key="viewFileButton" />,
        <DownloadFileButton key="downloadFileButton" />,
        <TranscribeButton key="transcribeButton" />,
      ];
    if (HIDDEN_TOOLS.has(String(item.key))) return [];
    if (item.key !== "strikeStyleButton") return [item];

    return [
      item,
      <BasicTextStyleButton basicTextStyle="code" key="codeStyleButton" />,
    ];
  });
}

export function FormattingBar({ t, askAi }: { t: T; askAi?: () => void }) {
  return (
    <FormattingToolbarController
      formattingToolbar={() => (
        <FormattingToolbar>
          {askAi && (
            <button
              className="aibutton"
              aria-label={t("askAiShort")}
              title={t("askAiShort")}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => askAi()}
            >
              <Sparkles />
            </button>
          )}
          {toolbarItems()}
        </FormattingToolbar>
      )}
    />
  );
}
