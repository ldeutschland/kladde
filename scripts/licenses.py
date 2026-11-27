import html
import json
import os
import re
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "apps" / "kladde"
OUTPUT = APP / "src" / "workspace" / "licenses.json"
APP_CRATE = "kladde"
FEATURES = "kladde/custom-protocol,kladde/distribution"
TARGETS = ("aarch64-apple-ios", "aarch64-apple-darwin", "x86_64-apple-darwin")
BUNDLED_TOOLS = (("tailwindcss", ""), ("vite", ""), ("rolldown", "vite"))
MODULES = "node_modules"
LICENSE_PREFIXES = ("license", "licence", "copying", "copyright", "notice", "unlicense")
SHARED_LICENSES = ("MPL-2.0", "CC0-1.0", "Unlicense", "BSL-1.0")
NON_LICENSE_WORDS = {"OR", "AND", "WITH"}
MAX_TEXT_BYTES = 1 << 20
CENTERED_INDENT = 12
TOOL_LICENSE_END = "# Licenses of bundled dependencies"
MIT_HOLDERS = "Copyright (c) <year> <copyright holders>"
RUST_DOCS = Path("share/doc/rust")
RUST_NOTICE = RUST_DOCS / "COPYRIGHT-library.html"
RUST_LICENSES = RUST_DOCS / "licenses"
RUST_URL = "https://github.com/rust-lang/rust"
RUST_HOLDERS = "The Rust Project Developers"
STD_START = '<h2 id="short-version">'
STD_END = '<h2 id="out-of-tree-dependencies">'
LITERT_FRAMEWORK = Path("CLiteRTLM.xcframework/ios-arm64/CLiteRTLM.framework")
LITERT_NOTICES = Path("third_party_licenses.bundle/oss_licenses.zip")
LITERT_URL = "https://github.com/google-ai-edge/LiteRT-LM"
MODELS = (
    ("Gemma 4 E2B", "https://huggingface.co/google/gemma-4-E2B-it"),
    ("Gemma 4 E4B", "https://huggingface.co/google/gemma-4-E4B-it"),
)
HTTPS = "https://"
GITHUB = "https://github.com/"
CONTACT = re.compile(r"\s*[<(][^>)]*[>)]")
GITHUB_SHORTHAND = re.compile(r"[\w.-]+/[\w.-]+")
LICENSE_ID = re.compile(r"[A-Za-z0-9.+-]+")
STD_DEPENDENCY = re.compile(r"(?s)<h3>📦 ([^<]+)</h3>(.*?)(?=<h3>|\Z)")
STD_LICENSE = re.compile(r"(?s)<b>License:</b>(.*?)</p>")
STD_URL = re.compile(r'<b>URL:</b>\s*<a href="([^"]+)"')
PRE_BLOCK = re.compile(r"(?s)<pre[^>]*>(.*?)</pre>")
TAG = re.compile(r"(?s)<[^>]+>")
BLOCK_END = re.compile(r"(?i)</p>|<br\s*/?>|</div>|</h[1-6]>|</li>")
SPACES = re.compile(r"[ \t]+")
BLANK_LINES = re.compile(r"\n{3,}")
NAME_VERSION = re.compile(r"^(.*?)-(\d+\.\d+.*)$")
SUMMARY_LICENSE = re.compile(r"License: (.*)")


@dataclass
class Package:
    name: str
    version: str
    license: str
    url: str
    texts: list[str]
    authors: list[str] = field(default_factory=list)


@dataclass
class References:
    apache: str
    mit: str
    shared: dict[str, str]


def run(command: list[str], cwd: Path = ROOT) -> str:
    return subprocess.run(command, cwd=cwd, capture_output=True, text=True, check=True).stdout


def unindented(line: str) -> str:
    stripped = line.strip()

    return stripped if len(line) - len(line.lstrip()) >= CENTERED_INDENT else line.rstrip()


def normalized(text: str) -> str:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")

    return BLANK_LINES.sub("\n\n", "\n".join(map(unindented, lines))).strip("\n")


def read_text(path: Path) -> str:
    if not path.is_file() or path.stat().st_size > MAX_TEXT_BYTES:
        return ""

    text = path.read_bytes().decode("utf-8", errors="replace")

    return "" if "\0" in text else normalized(text)


def unique(texts: list[str]) -> list[str]:
    return list(dict.fromkeys(text for text in texts if text))


def inside(folder: Path, path: Path) -> bool:
    return path.resolve().is_relative_to(folder.resolve())


def license_files(folder: Path) -> list[Path]:
    return sorted(
        path for path in folder.iterdir()
        if path.is_file() and path.name.lower().startswith(LICENSE_PREFIXES)
    )


def folder_texts(folder: Path, extra: str = "") -> list[str]:
    paths = license_files(folder)
    named = folder / extra if extra else None

    if named and inside(folder, named) and named not in paths:
        paths.append(named)

    return unique([read_text(path) for path in paths])


def https_url(value: str) -> str:
    url = value.strip().removeprefix("git+").removesuffix(".git").removesuffix("/")
    url = url.replace("git://", HTTPS).replace("ssh://git@", HTTPS)

    if url.startswith("github:"):
        url = GITHUB + url.removeprefix("github:")
    if url.startswith("git@github.com:"):
        url = GITHUB + url.removeprefix("git@github.com:")
    if GITHUB_SHORTHAND.fullmatch(url):
        url = GITHUB + url

    return url if url.startswith(HTTPS) and not any(c.isspace() for c in url) else ""


def holders(authors: list[str]) -> str:
    names = [CONTACT.sub("", author).strip() for author in authors]

    return ", ".join(name for name in names if name)


def license_ids(expression: str) -> set[str]:
    return set(LICENSE_ID.findall(expression)) - NON_LICENSE_WORDS


def sort_key(package: Package) -> tuple[str, str]:
    return package.name.lower(), package.version


def cargo_metadata(target: str) -> dict:
    command = ["cargo", "metadata", "--format-version", "1", "--locked", "--features", FEATURES]

    return json.loads(run(command + ["--filter-platform", target]))


def is_proc_macro(package: dict) -> bool:
    return any("proc-macro" in target["kind"] for target in package["targets"])


def normal_dependencies(node: dict) -> list[str]:
    return [dep["pkg"] for dep in node["deps"] if any(kind["kind"] is None for kind in dep["dep_kinds"])]


def shipped_crates(metadata: dict) -> list[dict]:
    packages = {package["id"]: package for package in metadata["packages"]}
    nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
    stack = [next(key for key, package in packages.items() if package["name"] == APP_CRATE and package["source"] is None)]
    seen: set[str] = set()

    while stack:
        current = stack.pop()

        if current not in seen:
            seen.add(current)
            stack.extend(dep for dep in normal_dependencies(nodes[current]) if not is_proc_macro(packages[dep]))

    return [packages[key] for key in seen if packages[key]["source"] is not None]


def crate_package(crate: dict) -> Package:
    folder = Path(crate["manifest_path"]).parent

    return Package(
        crate["name"],
        crate["version"],
        crate.get("license") or "",
        https_url(crate.get("repository") or crate.get("homepage") or ""),
        folder_texts(folder, crate.get("license_file") or ""),
        crate.get("authors") or [],
    )


def rust_packages() -> list[Package]:
    crates = {
        (crate["name"], crate["version"]): crate
        for target in TARGETS
        for crate in shipped_crates(cargo_metadata(target))
    }

    return sorted((crate_package(crate) for crate in crates.values()), key=sort_key)


def manifest_url(manifest: dict) -> str:
    repository = manifest.get("repository")
    location = repository.get("url", "") if isinstance(repository, dict) else repository or ""

    return https_url(location) or https_url(manifest.get("homepage") or "")


def manifest_license(manifest: dict) -> str:
    declared = manifest.get("license") or ""

    return declared.get("type", "") if isinstance(declared, dict) else str(declared)


def manifest_authors(manifest: dict) -> list[str]:
    author = manifest.get("author") or ""

    return [author.get("name", "") if isinstance(author, dict) else str(author)]


def tool_text(text: str) -> str:
    return normalized(text.split(TOOL_LICENSE_END)[0])


def npm_package(folder: Path) -> Package:
    manifest = json.loads((folder / "package.json").read_text(encoding="utf-8"))

    return Package(
        manifest.get("name") or folder.name,
        manifest.get("version") or "",
        manifest_license(manifest),
        manifest_url(manifest),
        unique([tool_text(text) for text in folder_texts(folder)]),
        manifest_authors(manifest),
    )


def tool_folders() -> list[Path]:
    folders: dict[str, Path] = {}

    for name, near in BUNDLED_TOOLS:
        base = folders[near].parent if near else APP / MODULES
        folders[name] = (base / name).resolve()

    return list(folders.values())


def package_root(source: Path) -> Path | None:
    folders = source.parts[:-1]

    if MODULES not in folders:
        return None

    index = len(folders) - 1 - folders[::-1].index(MODULES)
    scoped = index + 1 < len(folders) and folders[index + 1].startswith("@")
    end = index + (3 if scoped else 2)

    return Path(*folders[:end]) if end <= len(folders) else None


def map_sources(output: Path) -> list[Path]:
    return [
        Path(os.path.normpath(path.parent / source))
        for path in output.rglob("*.map")
        for source in json.loads(path.read_text(encoding="utf-8")).get("sources", [])
    ]


def bundled_folders() -> set[Path]:
    with tempfile.TemporaryDirectory() as output:
        run(["pnpm", "exec", "vite", "build", "--sourcemap", "--outDir", output, "--emptyOutDir", "--logLevel", "error"], cwd=APP)
        sources = map_sources(Path(output))

    roots = {package_root(source) for source in sources}

    return {root for root in roots if root and inside(ROOT / MODULES, root)}


def web_packages() -> list[Package]:
    folders = bundled_folders() | set(tool_folders())

    return sorted((npm_package(folder) for folder in folders), key=sort_key)


def pre_text(markup: str) -> str:
    return normalized(html.unescape(TAG.sub("", markup)))


def notice_texts(archive: zipfile.ZipFile) -> dict[str, list[str]]:
    notices: dict[str, list[str]] = {}

    for info in archive.infolist():
        if info.filename.endswith(".html") and info.file_size <= MAX_TEXT_BYTES:
            markup = archive.read(info).decode("utf-8", errors="replace")
            notices.setdefault(Path(info.filename).stem, []).extend(map(pre_text, PRE_BLOCK.findall(markup)))

    return notices


def litert_packages() -> list[Package]:
    root = Path(run(["sh", str(ROOT / "scripts" / "fetch-litert-lm.sh")]).strip())
    framework = root / LITERT_FRAMEWORK
    main = Package("LiteRT-LM", root.name.removeprefix("v"), "Apache-2.0", LITERT_URL, [read_text(framework / "LICENSE")])

    with zipfile.ZipFile(framework / LITERT_NOTICES) as archive:
        notices = notice_texts(archive)

    others = [Package(name, "", "", "", unique(texts)) for name, texts in notices.items()]

    return [main] + sorted(others, key=sort_key)


def markup_text(markup: str) -> str:
    text = html.unescape(TAG.sub("", BLOCK_END.sub("\n", markup)))

    return normalized("\n".join(SPACES.sub(" ", line).strip() for line in text.split("\n")))


def std_license_texts(summary: str, licenses: Path) -> list[str]:
    ids = sorted(license_ids(" ".join(SUMMARY_LICENSE.findall(summary))))
    texts = [read_text(licenses / f"{name}.txt") for name in ids]

    return [text.replace(MIT_HOLDERS, "Copyright (c) " + RUST_HOLDERS) for text in texts]


def std_dependency(title: str, section: str) -> Package:
    match = NAME_VERSION.match(title.strip())
    name, version = match.groups() if match else (title.strip(), "")
    declared = STD_LICENSE.search(section)
    url = STD_URL.search(section)

    return Package(
        name,
        version,
        markup_text(declared.group(1)) if declared else "",
        https_url(html.unescape(url.group(1))) if url else "",
        unique([pre_text(block) for block in PRE_BLOCK.findall(section)]),
    )


def std_packages() -> list[Package]:
    sysroot = Path(run(["rustc", "--print", "sysroot"]).strip())
    markup = (sysroot / RUST_NOTICE).read_text(encoding="utf-8")
    summary = markup_text(markup[markup.index(STD_START):markup.index(STD_END)])
    texts = [summary] + std_license_texts(summary, sysroot / RUST_LICENSES)
    version = run(["rustc", "--version"]).split()[1]
    main = Package("Rust Standard Library", version, "Apache-2.0 OR MIT", RUST_URL, unique(texts))
    others = [std_dependency(title, section) for title, section in STD_DEPENDENCY.findall(markup)]

    return [main] + sorted(others, key=sort_key)


def model_packages(references: References) -> list[Package]:
    return [Package(name, "", "Apache-2.0", url, [references.apache]) for name, url in MODELS]


def references(packages: list[Package]) -> References:
    licenses = Path(run(["rustc", "--print", "sysroot"]).strip()) / RUST_LICENSES
    shared: dict[str, str] = {}

    for package in sorted(packages, key=sort_key):
        if package.license in SHARED_LICENSES and len(package.texts) == 1:
            shared.setdefault(package.license, package.texts[0])

    return References(read_text(licenses / "Apache-2.0.txt"), read_text(licenses / "MIT.txt"), shared)


def fallback_texts(package: Package, references: References) -> list[str]:
    ids = license_ids(package.license)
    shared = [references.shared[name] for name in sorted(ids) if name in references.shared]
    owner = holders(package.authors) or "the " + package.name + " authors"

    if "Apache-2.0" in ids:
        return [references.apache]
    if shared:
        return shared[:1]
    if "MIT" in ids:
        return [references.mit.replace(MIT_HOLDERS, "Copyright (c) " + owner)]

    return []


def with_fallbacks(packages: list[Package], references: References) -> list[Package]:
    siblings = {(package.url, package.license): package.texts for package in packages if package.texts and package.url}

    for package in packages:
        if not package.texts:
            package.texts = siblings.get((package.url, package.license)) or fallback_texts(package, references)

    return packages


def collect() -> list[tuple[str, list[Package]]]:
    rust = rust_packages()
    web = web_packages()
    shared = references(rust + web)

    return [
        ("rust", with_fallbacks(rust, shared)),
        ("rust-std", std_packages()),
        ("web", with_fallbacks(web, shared)),
        ("litert", litert_packages()),
        ("models", model_packages(shared)),
    ]


def entry(package: Package, texts: dict[str, int]) -> dict:
    return {
        "name": package.name,
        "version": package.version,
        "license": package.license,
        "url": package.url,
        "texts": [texts.setdefault(text, len(texts)) for text in unique(package.texts)],
    }


def serialized(groups: list[tuple[str, list[Package]]]) -> dict:
    texts: dict[str, int] = {}
    listed = [{"id": group, "packages": [entry(package, texts) for package in packages]} for group, packages in groups]

    return {"texts": list(texts), "groups": listed}


def main(arguments: list[str]) -> int:
    data = serialized(collect())

    if arguments == ["--check"]:
        current = json.loads(OUTPUT.read_text(encoding="utf-8")) if OUTPUT.exists() else None

        if current == data:
            return 0

        print(f"{OUTPUT.relative_to(ROOT)} is out of date, run python3 scripts/licenses.py", file=sys.stderr)

        return 1

    OUTPUT.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
