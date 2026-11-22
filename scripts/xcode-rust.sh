set -eu
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
repo=$(cd "$SRCROOT/../../../../.." && pwd)
if [ -d "$repo/.tools/toolchain/bin" ]; then
  export CARGO_HOME="$repo/.tools/cargo"
  export RUSTUP_HOME="$repo/.tools/rustup"
  export PATH="$repo/.tools/toolchain/bin:$repo/.tools/cargo/bin:$PATH"
fi
if [ "${KLADDE_PREBUILT_SIM:-0}" = 1 ]; then
  test "$PLATFORM_NAME" = iphonesimulator
  dest="$SRCROOT/Externals/arm64/$CONFIGURATION"
  mkdir -p "$dest"
  cp "${KLADDE_STATIC_LIBRARY:?}" "$dest/libapp.a"
  exit 0
fi
cd "$repo/apps/kladde"
pnpm exec tauri ios xcode-script --platform "$PLATFORM_DISPLAY_NAME" --sdk-root "$SDKROOT" --framework-search-paths "$FRAMEWORK_SEARCH_PATHS" --header-search-paths "$HEADER_SEARCH_PATHS" --gcc-preprocessor-definitions "${GCC_PREPROCESSOR_DEFINITIONS:-}" --configuration "$CONFIGURATION" $ARCHS
