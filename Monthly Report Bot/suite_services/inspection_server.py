"""Local server control for the NeraVeda web shell (Next.js), home of the Inspection Reports module.

The web shell lives in the "Superintendent inspection Report" folder and serves web workspaces under
their own routes (Inspection Reports at /inspections). The Suite runs its server on this machine and
opens the module in the default browser. Drafts live in the browser's IndexedDB, which
is keyed to the page origin (http://localhost:<port>), so the port must stay stable or
existing drafts appear to vanish. The default is 3000, the port the app has always used.
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

SIR_FOLDER = "Superintendent inspection Report"
DEFAULT_PORT = 3000
HOST = "127.0.0.1"  # local only; every API request also needs the session NeraVeda opens it with
HEALTH_MARKER = '"neraveda-web"'  # returned by /api/health
LEGACY_MARKER = "SIR Inspect"  # manifest of builds from before the web shell
INSPECTIONS_PATH = "inspections"
# Sources newer than the last build → build, then serve the build (next_build_and_start.mjs). Never `next dev` by default:
# its file watcher reloads the page whenever OneDrive touches files in the app folder.
BUILD_AND_START = Path(__file__).with_name("next_build_and_start.mjs")
DEV_SWITCH = "NERAVEDA_WEB_DEV"  # =1: run `next dev` (for working on the app's code only)
READY_TIMEOUT = {"build": 900.0}  # a first build can take several minutes; seconds
SOURCE_ENTRIES = ("app", "components", "hooks", "lib", "public", "proxy.ts",
                  "next.config.mjs", "package.json", "postcss.config.mjs", "tsconfig.json")


class InspectionAppError(RuntimeError):
    """A problem the user can fix (missing Node.js, dependencies, busy port)."""


def app_dir(project_root):
    folder = (Path(project_root) / SIR_FOLDER).resolve()
    if not (folder / "package.json").is_file():
        raise FileNotFoundError("Superintendent Inspection Report app was not found.")
    return folder


def server_port():
    try:
        port = int(os.environ.get("SIR_PORT", DEFAULT_PORT))
    except ValueError:
        return DEFAULT_PORT
    return port if 1024 <= port <= 65535 else DEFAULT_PORT


def app_url(port=None):
    # Always "localhost": the browser's saved drafts belong to this exact origin.
    return f"http://localhost:{port or server_port()}/"


def inspections_url(port=None):
    return app_url(port) + INSPECTIONS_PATH


def find_node():
    node = shutil.which("node")
    if node:
        return node
    for base in (os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"),
                 os.environ.get("LOCALAPPDATA") and os.path.join(os.environ["LOCALAPPDATA"], "Programs")):
        if base and Path(base, "nodejs", "node.exe").is_file():
            return str(Path(base, "nodejs", "node.exe"))
    return None


def _newest_source_mtime(folder):
    newest = 0.0
    for name in SOURCE_ENTRIES:
        entry = folder / name
        if entry.is_file():
            newest = max(newest, entry.stat().st_mtime)
        elif entry.is_dir():
            for path in entry.rglob("*"):
                if path.is_file():
                    newest = max(newest, path.stat().st_mtime)
    return newest


def build_is_current(folder):
    """True when a production build exists and no source file is newer than it."""
    build_id = Path(folder) / ".next" / "BUILD_ID"
    return build_id.is_file() and build_id.stat().st_mtime >= _newest_source_mtime(Path(folder))


def stale_build_mode():
    """What to run when the build is missing or older than the sources."""
    return "dev" if os.environ.get(DEV_SWITCH) == "1" else "build"


def server_mode(folder):
    return "start" if build_is_current(folder) else stale_build_mode()


def ready_timeout(mode):
    return READY_TIMEOUT.get(mode, 180.0)


def server_command(node, folder, port, mode):
    next_bin = Path(folder) / "node_modules" / "next" / "dist" / "bin" / "next"
    if mode == "build":
        return [node, str(BUILD_AND_START), str(next_bin), "-H", HOST, "-p", str(port)]
    return [node, str(next_bin), mode, "-H", HOST, "-p", str(port)]


def cloud_sync_status(folder):
    """Describe where reports sync to, without exposing the connection string."""
    uri = os.environ.get("MONGODB_URI", "")
    for name in (".env.local", ".env"):
        env_file = Path(folder) / name
        if uri or not env_file.is_file():
            continue
        for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
            key, sep, value = line.strip().partition("=")
            if sep and key.strip() == "MONGODB_URI":
                uri = value.strip().strip('"').strip("'")
                break
    if not uri:
        # Moved out of the code folder into this PC's protected storage (python -m suite_services.access secrets import)
        try:
            import json
            from suite_services.access.config import read_secret
            uri = json.loads(read_secret("db_sir") or "{}").get("MONGODB_URI", "")
        except Exception:
            uri = ""
    if not uri:
        return "Not configured"
    if uri.startswith("mongodb+srv://") and ".mongodb.net" in uri:
        return "MongoDB Atlas"
    if any(host in uri for host in ("127.0.0.1", "localhost")):
        return "Local MongoDB"
    return "MongoDB"


def probe(port, timeout=1.5):
    """Return "sir" if the web shell answers on the port, "other" if something else does, None if free."""
    try:
        with socket.create_connection(("localhost", port), timeout=min(timeout, 1.0)):
            pass
    except OSError:
        return None
    for path, marker in (("api/health", HEALTH_MARKER), ("manifest.webmanifest", LEGACY_MARKER)):
        try:
            with urllib.request.urlopen(f"http://localhost:{port}/{path}", timeout=timeout) as response:
                if marker in response.read(4096).decode("utf-8", errors="replace"):
                    return "sir"
        except (urllib.error.URLError, OSError, ValueError):
            continue
    return "other"


def server_env(secret=None, extra_env=None, **fixed):
    """The server's environment: the launcher's per-run secret and database settings travel here, never on the
    command line or in the log."""
    env = dict(os.environ, NEXT_TELEMETRY_DISABLED="1", **fixed)
    if secret:
        env["NERAVEDA_WEB_SECRET"] = secret
    env.update(extra_env or {})
    return env


def _processes():
    """{pid: (parent pid, image name)} from a Toolhelp snapshot (no WMIC, no PowerShell)."""
    import ctypes
    from ctypes import wintypes

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
                    ("szExeFile", ctypes.c_wchar * 260)]
    kernel32 = ctypes.windll.kernel32
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    snapshot = kernel32.CreateToolhelp32Snapshot(0x2, 0)
    found = {}
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
        while ok:
            found[entry.th32ProcessID] = (entry.th32ParentProcessID, entry.szExeFile.lower())
            ok = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)
    return found


def listening_pid(port):
    """PID of the process listening on 127.0.0.1/localhost:<port>, or None."""
    try:
        output = subprocess.run(["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True, timeout=15,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in output.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[0] == "TCP" and parts[3] == "LISTENING" and parts[1].endswith(f":{port}"):
            try:
                return int(parts[4])
            except ValueError:
                continue
    return None


def stop_listener(port):
    """Stop a Node server left running on the port (e.g. started before this NeraVeda session).
    Only node.exe is stopped, together with its `next` parent; anything else is left alone. True if stopped."""
    pid = listening_pid(port)
    if pid is None:
        return False
    try:
        table = _processes()
    except Exception:
        return False
    if table.get(pid, (0, ""))[1] != "node.exe":
        return False
    top = pid
    for _ in range(2):  # `next dev` runs the listener as a child of another node process
        parent = table.get(top, (0, ""))[0]
        if table.get(parent, (0, ""))[1] == "node.exe":
            top = parent
    try:
        subprocess.run(["taskkill", "/PID", str(top), "/T", "/F"], capture_output=True, timeout=15,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        return False
    for _ in range(20):
        if listening_pid(port) is None:
            return True
        time.sleep(0.25)
    return False


def start_server(project_root, port=None, log_path=None, secret=None, extra_env=None):
    """Start the Next.js server without a console window. Returns (process, mode)."""
    folder = app_dir(project_root)
    port = port or server_port()
    node = find_node()
    if node is None:
        raise InspectionAppError(
            "Node.js was not found. Install Node.js 18 or later from https://nodejs.org and reopen NeraVeda.")
    if not (folder / "node_modules" / "next" / "dist" / "bin" / "next").is_file():
        raise InspectionAppError(
            f"The app's dependencies are not installed. Open a terminal in\n{folder}\nand run: npm install")
    mode = server_mode(folder)
    log = open(log_path, "a", encoding="utf-8", buffering=1) if log_path else subprocess.DEVNULL
    if log_path:
        log.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')}  next {mode} on {app_url(port)}\n")
    env = server_env(secret, extra_env, SIR_PORT=str(port))
    try:
        process = subprocess.Popen(
            server_command(node, folder, port, mode), cwd=str(folder), env=env,
            stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    finally:
        if log_path:
            log.close()  # the child keeps its own handle
    return process, mode


def wait_until_ready(process, port, timeout=180.0, interval=0.5):
    """Block until the app answers, the process exits, or the timeout passes."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            return False
        if probe(port, timeout=10) == "sir":
            return True
        time.sleep(interval)
    return False


def stop_server(process):
    """Stop the server and any worker processes it spawned."""
    if process is None or process.poll() is not None:
        return
    try:
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, timeout=15,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except (OSError, subprocess.SubprocessError):
        pass
    if process.poll() is None:
        process.kill()
