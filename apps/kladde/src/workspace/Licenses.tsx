import { useEffect, useState, type MouseEvent } from "react";
import type { T, Word } from "../locale/locale";
import { command } from "../platform/native";

interface LicensePackage {
  name: string;
  version: string;
  license: string;
  url: string;
  texts: number[];
}

interface LicenseGroup {
  id: string;
  packages: LicensePackage[];
}

interface LicenseData {
  texts: string[];
  groups: LicenseGroup[];
}

const HTTPS = "https://";
const APP_GROUP = "kladde";
const GROUP_TITLES: Record<string, Word> = {
  kladde: "licensesApp",
  rust: "licensesRust",
  "rust-std": "licensesRustStd",
  web: "licensesWeb",
  litert: "licensesLiteRt",
  models: "licensesModels",
};

function fields(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function parsedPackage(value: unknown, textCount: number): LicensePackage {
  const item = fields(value);
  const url = text(item.url);

  return {
    name: text(item.name),
    version: text(item.version),
    license: text(item.license),
    url: url.startsWith(HTTPS) ? url : "",
    texts: list(item.texts).filter(
      (index): index is number =>
        Number.isInteger(index) &&
        Number(index) >= 0 &&
        Number(index) < textCount,
    ),
  };
}

function parsedGroup(value: unknown, textCount: number): LicenseGroup {
  const group = fields(value);

  return {
    id: text(group.id),
    packages: list(group.packages)
      .map((item) => parsedPackage(item, textCount))
      .filter((item) => item.name),
  };
}

function parsedLicenses(raw: string): LicenseData {
  const data = fields(JSON.parse(raw));
  const texts = list(data.texts).map(text);

  return {
    texts,
    groups: list(data.groups).map((group) => parsedGroup(group, texts.length)),
  };
}

function useLicenses() {
  const [data, setData] = useState<LicenseData | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;

    import("./licenses.json?raw")
      .then((module) => {
        if (live) setData(parsedLicenses(module.default));
      })
      .catch(() => {
        if (live) setFailed(true);
      });

    return () => {
      live = false;
    };
  }, []);

  return { data, failed };
}

function matches(item: LicensePackage, query: string) {
  return (item.name + " " + item.license).toLowerCase().includes(query);
}

function openSource(
  event: MouseEvent<HTMLAnchorElement>,
  address: string,
  fail: (failed: boolean) => void,
) {
  event.preventDefault();
  fail(false);
  void command("open_web_source", { address }).catch(() => fail(true));
}

function AppNotice({ data, t }: { data: LicenseData; t: T }) {
  const [failed, setFailed] = useState(false);
  const app = data.groups.find((group) => group.id === APP_GROUP)?.packages[0];

  if (!app?.url) return null;

  return (
    <>
      <p>
        {t("licensesFree")}{" "}
        <a
          href={app.url}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(event) => openSource(event, app.url, setFailed)}
        >
          {app.url.slice(HTTPS.length)}
        </a>
      </p>
      {failed && <p role="alert">{t("linkFailed")}</p>}
    </>
  );
}

function PackageTexts({
  item,
  texts,
  t,
}: {
  item: LicensePackage;
  texts: string[];
  t: T;
}) {
  return (
    <>
      {item.url && (
        <p className="licensesource">
          {t("licensesSource")}: {item.url}
        </p>
      )}
      {item.texts.map((index) => (
        <pre key={index}>{texts[index]}</pre>
      ))}
    </>
  );
}

function PackageEntry({
  item,
  texts,
  t,
}: {
  item: LicensePackage;
  texts: string[];
  t: T;
}) {
  const [open, setOpen] = useState(false);

  return (
    <details
      className="licenseentry"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="grow">
          {item.name} <small>{item.version}</small>
        </span>
        <small>{item.license}</small>
      </summary>
      {open && <PackageTexts item={item} texts={texts} t={t} />}
    </details>
  );
}

function GroupSection({
  group,
  shown,
  texts,
  t,
}: {
  group: LicenseGroup;
  shown: LicensePackage[];
  texts: string[];
  t: T;
}) {
  const title = GROUP_TITLES[group.id];

  return (
    <section>
      <h3>
        {title ? t(title) : group.id} · {shown.length}
      </h3>
      {shown.map((item) => (
        <PackageEntry
          key={item.name + "@" + item.version}
          item={item}
          texts={texts}
          t={t}
        />
      ))}
    </section>
  );
}

function LicenseList({ data, t }: { data: LicenseData; t: T }) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const groups = data.groups
    .map((group) => ({
      group,
      shown: group.packages.filter((item) => matches(item, needle)),
    }))
    .filter(({ shown }) => shown.length);

  return (
    <>
      <AppNotice data={data} t={t} />
      <input
        type="search"
        value={query}
        placeholder={t("search")}
        aria-label={t("search")}
        onChange={(event) => setQuery(event.target.value)}
      />
      {groups.map(({ group, shown }) => (
        <GroupSection
          key={group.id}
          group={group}
          shown={shown}
          texts={data.texts}
          t={t}
        />
      ))}
      {!groups.length && <p role="status">{t("noResults")}</p>}
    </>
  );
}

export function Licenses({ t }: { t: T }) {
  const { data, failed } = useLicenses();

  return (
    <div className="licenses">
      <p>{t("licensesIntro")}</p>
      {failed && <p role="alert">{t("licensesFailed")}</p>}
      {!failed && !data && <p role="status">{t("loading")}</p>}
      {data && <LicenseList data={data} t={t} />}
    </div>
  );
}
