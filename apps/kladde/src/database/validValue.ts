import { type Notebook } from "../notebook/notebook";
import { splitList } from "./compute";
import { readOnlyTypes, type Field } from "./types";

export function validValue(field: Field, raw: string, book: Notebook) {
  if (raw.length > 8192) throw Error("Value too long");
  if (!raw) return "";
  if (field.type === "number" && !Number.isFinite(Number(raw)))
    throw Error("Invalid number");
  if (field.type === "url" && !/^https?:\/\//i.test(raw))
    throw Error("Invalid URL");
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw))
    throw Error("Invalid email");
  if (field.type === "phone" && !/^[+\d() .-]{2,50}$/.test(raw))
    throw Error("Invalid phone");

  if (field.type === "date") {
    const dates = raw.split("/");

    if (
      dates.length > 2 ||
      dates.some(
        (v) =>
          !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
          !Number.isFinite(Date.parse(v)) ||
          new Date(v).toISOString().slice(0, 10) !== v,
      ) ||
      (dates[1] && dates[1] < dates[0])
    )
      throw Error("Invalid date range");
  }

  if (field.type === "checkbox" && !["true", "false"].includes(raw))
    throw Error("Invalid checkbox");
  if (
    ["select", "status", "multi"].includes(field.type) &&
    raw.split(",").some((v) => !field.options.includes(v.trim()))
  )
    throw Error("Unknown option");
  if (readOnlyTypes.includes(field.type)) throw Error("Read only");
  if (field.type === "relation") return validRelation(field, raw, book);

  return raw;
}

const RELATION_LIMIT = 100;

function validRelation(field: Field, raw: string, book: Notebook) {
  const ids = [...new Set(splitList(raw))];
  const linked = (id: string) => {
    const page = book.pages.get(id);

    return page?.kind === "row" && page.parent === field.target;
  };

  if (!field.target || ids.length > RELATION_LIMIT || !ids.every(linked))
    throw Error("Invalid relation");

  return ids.join(",");
}
