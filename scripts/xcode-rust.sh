set -eu
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
repo=$(cd "$SRCROOT/../../../../.." && pwd)
if [ -d "$repo/.tools/toolchain/bin" ]; then
  export CARGO_HOME="$repo/.tools/cargo"
  export RUSTUP_HOME="$repo/.tools/rustup"
  export PATH="$repo/.tools/toolchain/bin:$repo/.tools/cargo/bin:$PATH"
fi
case "$PLATFORM_NAME" in
  iphonesimulator) litert_slice=ios-arm64-simulator ;;
  *) litert_slice=ios-arm64 ;;
esac
litert=$(sh "$repo/scripts/fetch-litert-lm.sh")/CLiteRTLM.xcframework/$litert_slice/CLiteRTLM.framework
frameworks="$TARGET_BUILD_DIR/$FRAMEWORKS_FOLDER_PATH"
mkdir -p "$frameworks"
rm -rf "$frameworks/CLiteRTLM.framework"
ditto "$litert" "$frameworks/CLiteRTLM.framework"
rm -rf "$frameworks/CLiteRTLM.framework/Headers" "$frameworks/CLiteRTLM.framework/Modules"
identity=-
if [ "${CODE_SIGNING_ALLOWED:-NO}" = YES ] && [ -n "${EXPANDED_CODE_SIGN_IDENTITY:-}" ]; then
  identity=$EXPANDED_CODE_SIGN_IDENTITY
fi
codesign --force --sign "$identity" --timestamp=none "$frameworks/CLiteRTLM.framework"
if [ "${KLADDE_PREBUILT_SIM:-0}" = 1 ]; then
  test "$PLATFORM_NAME" = iphonesimulator
  dest="$SRCROOT/Externals/arm64/$CONFIGURATION"
  mkdir -p "$dest"
  cp "${KLADDE_STATIC_LIBRARY:?}" "$dest/libapp.a"
  exit 0
fi
cd "$repo/apps/kladde"
pnpm exec tauri ios xcode-script --platform "$PLATFORM_DISPLAY_NAME" --sdk-root "$SDKROOT" --framework-search-paths "$FRAMEWORK_SEARCH_PATHS" --header-search-paths "$HEADER_SEARCH_PATHS" --gcc-preprocessor-definitions "${GCC_PREPROCESSOR_DEFINITIONS:-}" --configuration "$CONFIGURATION" $ARCHS
