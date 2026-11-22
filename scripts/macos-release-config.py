import json
import os
import plistlib
import re
import sys
from pathlib import Path

BUILD_NUMBER = re.compile(r"[1-9][0-9]{0,8}")
APP_DIR = Path("apps/kladde/src-tauri")

directory = Path(sys.argv[1]).resolve()
profile = plistlib.loads((directory / "profile.plist").read_bytes())
config = json.loads((APP_DIR / "tauri.conf.json").read_text())
team = os.environ["APPLE_TEAM_ID"]
prefix = profile["ApplicationIdentifierPrefix"][0]
app_id = prefix + "." + config["identifier"]
allowed = profile["Entitlements"].get("com.apple.application-identifier", "")
if team not in profile["TeamIdentifier"]:
    sys.exit("Provisioning profile belongs to a different team")
if app_id != allowed and not (allowed.endswith(".*") and app_id.startswith(allowed[:-1])):
    sys.exit("Provisioning profile does not authorize this app")

granted = plistlib.loads((APP_DIR / "macos.entitlements").read_bytes())
granted["com.apple.application-identifier"] = app_id
granted["com.apple.developer.team-identifier"] = team
entitlements = directory / "macos.entitlements"
entitlements.write_bytes(plistlib.dumps(granted))
macos = {
    "entitlements": str(entitlements),
    "files": {"embedded.provisionprofile": str(directory / "embedded.provisionprofile")},
}
build_number = os.environ.get("KLADDE_BUILD_NUMBER")
if build_number is not None:
    if not BUILD_NUMBER.fullmatch(build_number):
        sys.exit("KLADDE_BUILD_NUMBER must be a positive whole number")
    macos["bundleVersion"] = build_number
(directory / "bundle.json").write_text(json.dumps({"bundle": {"macOS": macos}}))
