import {
  DeleteLinkButton,
  EditLinkButton,
  LinkToolbar,
  LinkToolbarController,
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  type LinkToolbarProps,
} from "@blocknote/react";
import { ExternalLink } from "lucide-react";
import { openLink, opensLinks } from "./openLink";
import { pageLinkContextOf } from "./pageLinkSpec";

const ICON_SIZE = 16;

function OpenLinkButton({ url }: { url: string }) {
  const Components = useComponentsContext()!;
  const dictionary = useDictionary();
  const context = pageLinkContextOf(useBlockNoteEditor());
  const label = dictionary.link_toolbar.open.tooltip;

  if (!opensLinks(context)) return null;

  return (
    <Components.LinkToolbar.Button
      className="bn-button"
      label={label}
      mainTooltip={label}
      isSelected={false}
      icon={<ExternalLink size={ICON_SIZE} />}
      onClick={() => openLink(context, url)}
    />
  );
}

function NotebookLinkToolbar(props: LinkToolbarProps) {
  return (
    <LinkToolbar {...props}>
      <EditLinkButton {...props} />
      <OpenLinkButton url={props.url} />
      <DeleteLinkButton
        range={props.range}
        setToolbarOpen={props.setToolbarOpen}
      />
    </LinkToolbar>
  );
}

export function LinkBar() {
  return <LinkToolbarController linkToolbar={NotebookLinkToolbar} />;
}
