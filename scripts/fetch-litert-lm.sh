set -eu
version=v0.20.0
base="https://github.com/google-ai-edge/LiteRT-LM/releases/download/$version"
target="$(cd "$(dirname "$0")/.." && pwd)/.tools/litert-lm/$version"

fetch() {
  name=$1
  sum=$2
  if [ -d "$target/$name" ]; then
    return 0
  fi
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  curl --fail --location --proto '=https' --tlsv1.2 --silent --show-error --output "$work/$name.zip" "$base/$name.zip"
  echo "$sum  $work/$name.zip" | shasum -a 256 --check --quiet
  mkdir -p "$work/unpacked" "$target"
  ditto -x -k "$work/$name.zip" "$work/unpacked"
  test -d "$work/unpacked/$name"
  mv "$work/unpacked/$name" "$target/$name"
  rm -rf "$work"
  trap - EXIT
}

fetch CLiteRTLM.xcframework ae6b2b2ea3e46964152110ad5bd64b754f39273add2eb4cc417bbbbd72c5e6e7
if [ "${1:-}" = "--mac" ]; then
  fetch CLiteRTLM_mac.xcframework ed5943902177e8df2ec18c5a1e85b5dcb74b55e6cab84da95d0a00776fb4a270
fi
echo "$target"
