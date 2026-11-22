import {
  ArrowUpDown,
  Download,
  ListFilter,
  Plus,
  Search,
  SlidersHorizontal,
  Table2,
  Workflow,
} from "lucide-react";
import { fields } from "../database/fields";
import { type View } from "../database/types";
import { layoutIcons } from "./icons";
import type { OpenMenu, ViewContext } from "./types";

const QUERY_LENGTH = 200;

function ViewTabs({
  tabs,
  context,
  openMenu,
  select,
}: {
  tabs: View[];
  context: ViewContext;
  openMenu: OpenMenu;
  select: (id: string) => void;
}) {
  const { active, t } = context;

  return (
    <div className="tabs">
      {tabs.map((v) => {
        const Icon = layoutIcons[v.type] ?? Table2;

        return (
          <button
            key={v.id}
            aria-pressed={v.id === active.id}
            onClick={(e) => {
              if (v.id === active.id) {
                openMenu("view", e);

                return;
              }

              select(v.id);
            }}
          >
            <Icon size={16} />
            {v.name}
          </button>
        );
      })}
      <button
        className="addview"
        aria-label={t("newView")}
        title={t("newView")}
        onClick={(e) => openMenu("layout", e)}
      >
        <Plus size={16} />
      </button>
    </div>
  );
}

function filtered(active: View) {
  return (
    active.filters.length > 0 || !!active.groups?.some((g) => g.filters.length)
  );
}

export function DatabaseBar({
  tabs,
  context,
  query,
  search,
  openMenu,
  select,
  automations,
  exportCsv,
  create,
}: {
  tabs: View[];
  context: ViewContext;
  query: string;
  search: (query: string) => void;
  openMenu: OpenMenu;
  select: (id: string) => void;
  automations: () => void;
  exportCsv: () => void;
  create: () => void;
}) {
  const { active, t } = context;

  return (
    <div className="dbbar">
      <ViewTabs
        tabs={tabs}
        context={context}
        openMenu={openMenu}
        select={select}
      />
      <div className="dbtools">
        <button
          title={t("automations")}
          aria-label={t("automations")}
          onClick={automations}
        >
          <Workflow size={16} />
        </button>
        <button
          aria-label={t("filter")}
          title={t("filter")}
          data-active={filtered(active)}
          onClick={(e) => openMenu("filter", e)}
        >
          <ListFilter size={16} />
        </button>
        <button
          aria-label={t("sort")}
          title={t("sort")}
          data-active={active.sort !== "" || active.descending}
          onClick={(e) => openMenu("sort", e)}
        >
          <ArrowUpDown size={16} />
        </button>
        <label className="dbsearch">
          <Search size={16} />
          <input
            aria-label={t("search")}
            placeholder={t("search")}
            maxLength={QUERY_LENGTH}
            value={query}
            onChange={(e) => search(e.target.value)}
          />
        </label>
        <button
          aria-label={t("viewSettings")}
          title={t("viewSettings")}
          onClick={(e) => openMenu("view", e)}
        >
          <SlidersHorizontal size={16} />
        </button>
        <button aria-label={t("csv")} title={t("csv")} onClick={exportCsv}>
          <Download size={16} />
        </button>
        <button className="primary" onClick={create}>
          {t("newShort")}
        </button>
      </div>
    </div>
  );
}

export function SummaryLine({
  context,
  statistic,
}: {
  context: ViewContext;
  statistic: number | null;
}) {
  const { active, db, t } = context;
  const summary = active.summary;

  if (!summary) return null;

  return (
    <p className="dbsummary">
      {t(summary.calculation)}{" "}
      {summary.calculation !== "count" && fields(db).get(summary.field)?.name} ·{" "}
      <strong>{statistic?.toLocaleString() ?? "—"}</strong>
    </p>
  );
}
