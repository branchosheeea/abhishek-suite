"""Local server control for Workspace 07, DNV Emissions Validation & Intelligence (Next.js app).

The app lives in the "Emission Correction Assitant" folder and runs as its own local web server on port 3001
(the Inspection Reports web shell keeps port 3000). It listens on 127.0.0.1 only. Node discovery, the server
command and process shutdown are shared with suite_services.inspection_server.
"""
from __future__ import annotations

import os
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

from suite_services.inspection_server import InspectionAppError, find_node, server_command, server_env, stop_listener, stop_server

EVI_FOLDER = "Emission Correction Assitant"
DEFAULT_PORT = 3001
HEALTH_MARKER = '"neraveda-emissions"'  # returned by /api/health
SOURCE_ENTRIES = ("app", "components", "lib", "proxy.ts", "next.config.mjs", "package.json", "postcss.config.mjs", "tsconfig.json")

__all__ = ["EVI_FOLDER", "DEFAULT_PORT", "InspectionAppError", "app_dir", "server_port", "app_url", "probe",
           "build_is_current", "server_mode", "start_server", "wait_until_ready", "stop_server", "stop_listener"]


def app_dir(project_root):
    folder = (Path(project_root) / EVI_FOLDER).resolve()
    if not (folder / "package.json").is_file():
        raise FileNotFoundError("DNV Emissions Validation app was not found.")
    return folder


def server_port():
    try:
        port = int(os.environ.get("EMISSIONS_PORT", DEFAULT_PORT))
    except ValueError:
        return DEFAULT_PORT
    return port if 1024 <= port <= 65535 else DEFAULT_PORT


def app_url(port=None):
    return f"http://localhost:{port or server_port()}/"


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


def probe(port, timeout=1.5):
    """Return "evi" if this app answers on the port, "other" if something else does, None if free."""
    try:
        with socket.create_connection(("localhost", port), timeout=min(timeout, 1.0)):
            pass
    except OSError:
        return None
    try:
        with urllib.request.urlopen(f"http://localhost:{port}/api/health", timeout=timeout) as response:
            if HEALTH_MARKER in response.read(4096).decode("utf-8", errors="replace"):
                return "evi"
    except (urllib.error.URLError, OSError, ValueError):
        pass
    return "other"


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
    env = server_env(secret, extra_env, EMISSIONS_PORT=str(port))
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
        if probe(port, timeout=10) == "evi":
            return True
        time.sleep(interval)
    return False
