set -eu
: "${APPLE_DEVELOPMENT_TEAM:?Apple Development Team required}"
: "${KLADDE_PROVISIONING_PROFILE:?Path to the App Store provisioning profile required}"
: "${KLADDE_BUILD_NUMBER:?Build number required, it must grow with every upload}"
case "$KLADDE_BUILD_NUMBER" in
  ''|0*|*[!0-9]*) echo "KLADDE_BUILD_NUMBER must be a positive whole number" >&2; exit 2 ;;
esac
test -f "$KLADDE_PROVISIONING_PROFILE"
security cms -D -i "$KLADDE_PROVISIONING_PROFILE" | plutil -extract TeamIdentifier.0 raw - | grep -Fxq -- "$APPLE_DEVELOPMENT_TEAM"
IOS_MOBILE_PROVISION=$(base64 -i "$KLADDE_PROVISIONING_PROFILE")
export IOS_MOBILE_PROVISION
pnpm install --frozen-lockfile
method=${KLADDE_IOS_EXPORT_METHOD:-app-store-connect}
case "$method" in
  app-store-connect|release-testing) ;;
  *) exit 2 ;;
esac
share_info=apps/kladde/src-tauri/gen/apple/Share/Info.plist
share_backup=$(mktemp)
cp "$share_info" "$share_backup"
trap 'cp "$share_backup" "$share_info"; rm -f "$share_backup"' EXIT
plutil -replace CFBundleVersion -string "$KLADDE_BUILD_NUMBER" "$share_info"
pnpm --filter kladde exec tauri ios build --ci --target aarch64 --export-method "$method" --config "{\"bundle\":{\"iOS\":{\"bundleVersion\":\"$KLADDE_BUILD_NUMBER\"}}}"
