set -eu
: "${APPLE_SIGNING_IDENTITY:?Code signing identity required}"
cd "$(dirname "$0")/.."
if [ -x .tools/cargo/bin/cargo ] && [ -d .tools/rustup/toolchains ]; then
  . ./scripts/env.sh
elif ! command -v cargo >/dev/null 2>&1; then
  export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "Cargo fehlt. Installiere die Rust-Toolchain mit rustup." >&2
  exit 1
fi
pnpm install --frozen-lockfile
if [ -n "${KLADDE_MAC_PROVISIONING_PROFILE:-}" ]; then
  : "${APPLE_TEAM_ID:?Apple Team ID required for the provisioning profile}"
  signing_dir=$(mktemp -d)
  trap 'rm -rf "$signing_dir"' EXIT
  cp "$KLADDE_MAC_PROVISIONING_PROFILE" "$signing_dir/embedded.provisionprofile"
  chmod 644 "$signing_dir/embedded.provisionprofile"
  security cms -D -i "$signing_dir/embedded.provisionprofile" -o "$signing_dir/profile.plist"
  python3 scripts/macos-release-config.py "$signing_dir"
  pnpm --filter kladde exec tauri build --features distribution --bundles app --config "$signing_dir/bundle.json"
else
  echo "Warnung: ohne KLADDE_MAC_PROVISIONING_PROFILE liegt der Datenbankschlüssel im dateibasierten Schlüsselbund statt im Data-Protection-Schlüsselbund." >&2
  pnpm --filter kladde exec tauri build --bundles app
fi
app="${CARGO_TARGET_DIR:-target}/release/bundle/macos/Kladde.app"
codesign --verify --deep --strict "$app"
requirement=$(codesign -d -r- "$app" 2>&1)
case "$requirement" in
  *cdhash*) echo "Kladde.app has no stable signature" >&2; exit 1 ;;
esac
echo "$app"
