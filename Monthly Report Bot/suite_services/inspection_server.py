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
HOST = "127.0.0.1"  # local only: the report API has no authentication
HEALTH_MARKER = '"neraveda-web"'  # returned by /api/health
LEGACY_MARKER = "SIR Inspect"  # manifest of builds from before the web shell
INSPECTIONS_PATH = "inspections"
SOURCE_ENTRIES = ("app", "components", "hooks", "lib", "public",
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


def server_mode(folder):
    return "start" if build_is_current(folder) else "dev"


def server_command(node, folder, port, mode):
    next_bin = Path(folder) / "node_modules" / "next" / "dist" / "bin" / "next"
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


def start_server(project_root, port=None, log_path=None):
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
    env = dict(os.environ, NEXT_TELEMETRY_DISABLED="1")
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
