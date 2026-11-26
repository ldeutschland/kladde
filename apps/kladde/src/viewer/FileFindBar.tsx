import type { T } from "../locale/locale";
import { FindField } from "../search/FindBar";
import type { FileFind } from "./useFileFind";

export function FileFindBar({ find, t }: { find: FileFind; t: T }) {
  if (!find.open) return null;

  return (
    <div className="findspot">
      <FindField
        label={t("findInFile")}
        placeholder={t("findInFileField")}
        query={find.query}
        requested={find.requested}
        find={find}
        setQuery={find.setQuery}
        t={t}
        close={find.hide}
      />
    </div>
  );
}
