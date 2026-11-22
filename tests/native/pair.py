import json
import os
from pathlib import Path
import subprocess
import time
import socket
import sys
import uuid

q = Path(os.environ["KLADDE_QA_DIR"]).resolve()
sim = os.environ["SIMULATOR_ID"]
bundle = "de.kladde.native-qa"
launch_bin = q / "KladdeQA.app/Contents/MacOS/kladde"
sim_data = Path(subprocess.check_output(["xcrun", "simctl", "get_app_container", sim, bundle, "data"], text=True).strip())
app_dir = Path("Library/Application Support/de.kladde.notebook/acceptance")
run = str(uuid.uuid4())
results = []

def stage(device, name, expected=None):
    directory = (Path.home() if device == "macos" else sim_data) / app_dir / run
    report = directory / "result.json"
    report.unlink(missing_ok=True)
    env = dict(os.environ)
    prefix = "" if device == "macos" else "SIMCTL_CHILD_"
    env[prefix + "KLADDE_QA_RUN"] = run
    env[prefix + "KLADDE_QA_STAGE"] = name
    start = time.monotonic()
    with (q / (device + "-" + name + ".log")).open("w") as logfile:
        process = None
        try:
            if device == "macos":
                process = subprocess.Popen([launch_bin], stdout=logfile, stderr=logfile, env=env)
            else:
                subprocess.run(["xcrun","simctl","launch",sim,bundle],env=env,stdout=logfile,stderr=logfile,check=True)
            while not report.exists():
                if process is not None and process.poll() is not None:
                    raise RuntimeError("Native Mac test exited early")
                if time.monotonic()-start > (150 if name == "seed" else 40):
                    raise TimeoutError(str(report))
                time.sleep(.01)
            elapsed = round((time.monotonic()-start)*1000)
            result = json.loads(report.read_text())
            result.update(device=device, process_to_report_ms=elapsed)
            if process:
                result["app_rss_kib"]=int(subprocess.check_output(["ps","-o","rss=","-p",str(process.pid)],text=True))
            print(json.dumps(result,ensure_ascii=False),flush=True)
            results.append(result)
            if result["stage"]!=name or result["result"].startswith("ERROR") or expected and result["result"]!=expected:
                raise ValueError(str(result))
            return result
        finally:
            if process is not None:
                process.terminate()
                process.wait(timeout=10)
            elif device=="ios":
                subprocess.run(["xcrun","simctl","terminate",sim,bundle],capture_output=True)

def start_relay():
    handle=(q/"relay.log").open("a")
    proc=subprocess.Popen([os.environ["KLADDE_QA_RELAY"]],stdout=handle,stderr=handle)
    handle.close()
    for _ in range(100):
        if proc.poll() is not None: raise RuntimeError("Relay unavailable")
        try:
            with socket.create_connection(("127.0.0.1",17446),timeout=.1): return proc
        except OSError: time.sleep(.05)
    proc.terminate()
    raise TimeoutError("Relay")

if len(sys.argv)==2:
    run=str(uuid.UUID(sys.argv[1]))
    stage("macos","launch","home-and-tree-laid-out")
    sys.exit(0)
relay=start_relay()
try:
    stage("macos","register","registered")
    stage("ios","login","signed-in")
finally:
    relay.terminate()
    relay.wait(timeout=10)
for device in ["macos","ios"]:
    stage(device,"edit","offline-saved")
relay=start_relay()
try:
    for device in ["ios","macos"]: stage(device,"push","uploaded")
    mac=stage("macos","verify")
    ios=stage("ios","verify")
    assert mac["result"]==ios["result"]
    stage("ios","backup","archived")
finally:
    relay.terminate()
    relay.wait(timeout=10)
run=str(uuid.uuid4())
stage("ios","restore","restored-with-attachment")
run=str(uuid.uuid4())
stage("macos","seed","seeded")
launch=stage("macos","launch","home-and-tree-laid-out")
(q/"results.json").write_text(json.dumps(results,indent=2))
if launch["process_to_report_ms"]>=1000: raise RuntimeError("Startup exceeded one second")
