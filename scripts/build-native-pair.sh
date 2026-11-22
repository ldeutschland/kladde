set -eu
: "${SIMULATOR_ID:?Select a booted iPhone simulator}"
: "${KLADDE_QA_DIR:?Select an empty private test directory}"
root=$(pwd)
q="$KLADDE_QA_DIR"
umask 077
mkdir -p "$q"
if [ ! -f "$q/ca.der" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=Kladde-Local-Test-CA -keyout "$q/ca.key" -out "$q/ca.pem"
  openssl x509 -in "$q/ca.pem" -outform der -out "$q/ca.der"
fi
openssl req -new -newkey rsa:2048 -nodes -subj /CN=localhost -keyout "$q/server.key" -out "$q/server.csr"
cat > "$q/extensions" <<'EXT'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=IP:127.0.0.1
EXT
openssl x509 -req -in "$q/server.csr" -CA "$q/ca.pem" -CAkey "$q/ca.key" -CAcreateserial -days 2 -extfile "$q/extensions" -out "$q/server.pem"
export KLADDE_QA_CA="$q/ca.der" VITE_KLADDE_NATIVE_QA=1
pnpm --filter kladde exec tsc --noEmit
pnpm --filter kladde exec vite build --outDir "$q/dist"
export TAURI_CONFIG
TAURI_CONFIG=$(python3 -c 'import json,sys; print(json.dumps({"build":{"frontendDist":sys.argv[1]}}))' "$q/dist")
cargo build --locked --release -p kladde --bin kladde --features custom-protocol,native-acceptance > "$q/mac-build.log" 2>&1 &
mac=$!
sim_target="${KLADDE_SIM_TARGET:-$root/target}"
CARGO_TARGET_DIR="$sim_target" cargo build --locked --release -p kladde --lib --target aarch64-apple-ios-sim --features custom-protocol,native-acceptance > "$q/ios-build.log" 2>&1
wait "$mac"
mkdir -p "$q/KladdeQA.app/Contents/MacOS"
python3 - "$q/KladdeQA.app/Contents/Info.plist" <<'PYPLIST'
import plistlib,sys
with open(sys.argv[1],"wb") as f:
    plistlib.dump(dict(CFBundleName="KladdeQA",CFBundleIdentifier="de.kladde.native-qa",CFBundleExecutable="kladde",CFBundlePackageType="APPL",CFBundleVersion="1",NSHighResolutionCapable=True),f)
PYPLIST
cp target/release/kladde "$q/KladdeQA.app/Contents/MacOS/kladde"
codesign --force -s - "$q/KladdeQA.app"
xcodebuild -project apps/kladde/src-tauri/gen/apple/kladde.xcodeproj -scheme kladde_iOS -configuration release -destination "id=$SIMULATOR_ID" -derivedDataPath "$q/ios" KLADDE_PREBUILT_SIM=1 KLADDE_STATIC_LIBRARY="$sim_target/aarch64-apple-ios-sim/release/libkladde_app.a" PRODUCT_BUNDLE_IDENTIFIER=de.kladde.native-qa -parallelizeTargets build > "$q/xcode.log" 2>&1
xcrun simctl install "$SIMULATOR_ID" "$q/ios/Build/Products/release-iphonesimulator/Kladde.app"
