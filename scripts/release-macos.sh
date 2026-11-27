set -eu
: "${APPLE_SIGNING_IDENTITY:?Apple Distribution identity required}"
: "${APPLE_INSTALLER_IDENTITY:?Mac Installer Distribution identity required}"
: "${APPLE_TEAM_ID:?Apple Team ID required}"
: "${KLADDE_MAC_PROVISIONING_PROFILE:?Path to the Mac App Store provisioning profile required}"
: "${KLADDE_BUILD_NUMBER:?Build number required, it must grow with every upload}"
signing_dir=$(mktemp -d)
trap 'rm -rf "$signing_dir"' EXIT
cp "$KLADDE_MAC_PROVISIONING_PROFILE" "$signing_dir/embedded.provisionprofile"
chmod 644 "$signing_dir/embedded.provisionprofile"
security cms -D -i "$signing_dir/embedded.provisionprofile" -o "$signing_dir/profile.plist"
python3 scripts/macos-release-config.py "$signing_dir"
pnpm install --frozen-lockfile
pnpm --filter kladde exec tauri build --features distribution --bundles app --config "$signing_dir/bundle.json"
bundle="${CARGO_TARGET_DIR:-target}/release/bundle/macos"
app="$bundle/Kladde.app"
cmp "$signing_dir/embedded.provisionprofile" "$app/Contents/embedded.provisionprofile"
codesign --verify --deep --strict "$app"
codesign -d --entitlements - --xml "$app" > "$signing_dir/signed.entitlements" 2>/dev/null
test "$(/usr/libexec/PlistBuddy -c 'Print :com.apple.security.app-sandbox' "$signing_dir/signed.entitlements")" = true
test -f "$app/Contents/Resources/PrivacyInfo.xcprivacy"
xcrun productbuild --sign "$APPLE_INSTALLER_IDENTITY" --component "$app" /Applications "$bundle/Kladde.pkg"
pkgutil --check-signature "$bundle/Kladde.pkg"
echo "$bundle/Kladde.pkg"
