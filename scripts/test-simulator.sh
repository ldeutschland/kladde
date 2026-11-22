set -eu
: "${SIMULATOR_ID:?Select a booted iPhone from xcrun simctl list devices}"
root=$(pwd)
pnpm build
cargo build --release --locked -p kladde --lib --features custom-protocol --target aarch64-apple-ios-sim
project=apps/kladde/src-tauri/gen/apple/kladde.xcodeproj
lib="${CARGO_TARGET_DIR:-$root/target}/aarch64-apple-ios-sim/release/libkladde_app.a"
mkdir -p artifacts
xcodebuild -project "$project" -scheme NotebookSmoke -configuration release -destination "id=$SIMULATOR_ID" -derivedDataPath "$root/artifacts/simulator" KLADDE_PREBUILT_SIM=1 KLADDE_STATIC_LIBRARY="$lib" -parallel-testing-enabled NO test
