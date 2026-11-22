import { useState } from "react";
import { useAsk } from "../ui/dialog";
import type { T } from "../locale/locale";
import { useUndo } from "./useUndo";

export function useEditSession<S>(
  initial: S,
  startEditing: boolean,
  close: () => void,
  t: T,
) {
  const history = useUndo(initial);
  const [editing, setEditing] = useState(startEditing);
  const [ask, asking] = useAsk(t);

  async function mayDiscard() {
    if (!editing || !history.changed) return true;
    const answer = await ask(t("discardChanges"), undefined, {
      action: t("discard"),
      danger: true,
    });

    return answer !== null;
  }

  return {
    history,
    editing,
    asking,
    start(value: S) {
      history.reset(value);
      setEditing(true);
    },
    async leave() {
      if (await mayDiscard()) setEditing(false);
    },
    async requestClose() {
      if (await mayDiscard()) close();
    },
  };
}
