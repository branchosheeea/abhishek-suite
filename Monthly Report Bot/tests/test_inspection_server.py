import http.server
import os
import socket
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from suite_services import inspection_server as sir


def _make_app(root):
    folder = Path(root) / sir.SIR_FOLDER
    (folder / "app").mkdir(parents=True)
    (folder / "app" / "page.tsx").write_text("export default 1")
    (folder / "package.json").write_text("{}")
    return folder


def _serve(body):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            payload = body.encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class InspectionServerTests(unittest.TestCase):
    def test_missing_app_folder_is_reported(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaises(FileNotFoundError):
                sir.app_dir(Path(root))

    def test_app_dir_is_absolute(self):
        with tempfile.TemporaryDirectory() as root:
            folder = _make_app(root)
            previous = os.getcwd()
            os.chdir(root)
            try:
                self.assertEqual(sir.app_dir(Path(".")), folder.resolve())
            finally:
                os.chdir(previous)

    def test_port_defaults_to_3000_so_browser_drafts_stay_visible(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SIR_PORT", None)
            self.assertEqual(sir.server_port(), 3000)
            self.assertEqual(sir.app_url(), "http://localhost:3000/")
            self.assertEqual(sir.inspections_url(), "http://localhost:3000/inspections")
        for value, expected in (("3100", 3100), ("abc", 3000), ("80", 3000)):
            with patch.dict(os.environ, {"SIR_PORT": value}):
                self.assertEqual(sir.server_port(), expected)

    def test_server_command_binds_locally(self):
        command = sir.server_command("node", Path("C:/app"), 3000, "start")
        self.assertEqual(command[0], "node")
        self.assertTrue(command[1].replace("\\", "/").endswith("node_modules/next/dist/bin/next"))
        self.assertEqual(command[2:], ["start", "-H", "127.0.0.1", "-p", "3000"])

    def test_build_freshness_controls_mode(self):
        with tempfile.TemporaryDirectory() as root:
            folder = _make_app(root)
            self.assertEqual(sir.server_mode(folder), "build")  # never built
            build_id = folder / ".next" / "BUILD_ID"
            build_id.parent.mkdir()
            build_id.write_text("x")
            source = folder / "app" / "page.tsx"
            for path in (source, folder / "package.json"):
                os.utime(path, (1_000, 1_000))
            os.utime(build_id, (2_000, 2_000))
            self.assertEqual(sir.server_mode(folder), "start")
            os.utime(source, (3_000, 3_000))  # edited after the build
            self.assertEqual(sir.server_mode(folder), "build")
            with patch.dict(os.environ, {"NERAVEDA_WEB_DEV": "1"}):
                self.assertEqual(sir.server_mode(folder), "dev")  # only when working on the app's code
            self.assertEqual(sir.ready_timeout("build"), 900.0)
            self.assertEqual(sir.ready_timeout("start"), 180.0)

    def test_cloud_sync_status_hides_connection_string(self):
        cases = {
            "MONGODB_URI=mongodb+srv://user:secret@cluster0.abc.mongodb.net/?x=1": "MongoDB Atlas",
            "MONGODB_URI=mongodb://127.0.0.1:27017": "Local MongoDB",
            "MONGODB_URI=mongodb://db.internal:27017": "MongoDB",
            "# MONGODB_URI not set": "Not configured",
        }
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("MONGODB_URI", None)
            for line, expected in cases.items():
                with tempfile.TemporaryDirectory() as root:
                    (Path(root) / ".env.local").write_text(line + "\n")
                    self.assertEqual(sir.cloud_sync_status(Path(root)), expected)

    def test_probe_distinguishes_free_app_and_other(self):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            free_port = sock.getsockname()[1]
        self.assertIsNone(sir.probe(free_port))

        shell = _serve('{"app":"neraveda-web","modules":["inspections"]}')
        legacy = _serve('{"short_name":"SIR Inspect"}')
        other = _serve("<html>something else</html>")
        try:
            self.assertEqual(sir.probe(shell.server_address[1]), "sir")
            self.assertEqual(sir.probe(legacy.server_address[1]), "sir")
            self.assertEqual(sir.probe(other.server_address[1]), "other")
        finally:
            for server in (shell, legacy, other):
                server.shutdown()

    def test_missing_node_is_reported(self):
        with tempfile.TemporaryDirectory() as root:
            _make_app(root)
            with patch.object(sir, "find_node", return_value=None):
                with self.assertRaisesRegex(sir.InspectionAppError, "Node.js"):
                    sir.start_server(Path(root), 3000)

    def test_missing_dependencies_are_reported(self):
        with tempfile.TemporaryDirectory() as root:
            _make_app(root)
            with patch.object(sir, "find_node", return_value="node"):
                with self.assertRaisesRegex(sir.InspectionAppError, "npm install"):
                    sir.start_server(Path(root), 3000)

    def test_start_server_runs_next_without_console(self):
        with tempfile.TemporaryDirectory() as root:
            folder = _make_app(root).resolve()
            next_bin = folder / "node_modules" / "next" / "dist" / "bin" / "next"
            next_bin.parent.mkdir(parents=True)
            next_bin.touch()
            log = Path(root) / "server.log"
            with patch.object(sir, "find_node", return_value="node"), \
                    patch("suite_services.inspection_server.subprocess.Popen") as popen:
                process, mode = sir.start_server(Path(root), 3000, log)

            self.assertIs(process, popen.return_value)
            self.assertEqual(mode, "build")
            args, kwargs = popen.call_args
            # Not `next dev`: build, then serve the build, so OneDrive activity cannot reload the page.
            self.assertEqual(args[0], ["node", str(sir.BUILD_AND_START), str(next_bin), "-H", "127.0.0.1", "-p", "3000"])
            self.assertTrue(sir.BUILD_AND_START.is_file())
            self.assertEqual(kwargs["cwd"], str(folder))
            self.assertEqual(kwargs["creationflags"], subprocess.CREATE_NO_WINDOW)
            self.assertEqual(kwargs["env"]["NEXT_TELEMETRY_DISABLED"], "1")
            self.assertIn("next build on http://localhost:3000/", log.read_text(encoding="utf-8"))

    def test_wait_until_ready_stops_when_process_exits(self):
        class Exited:
            def poll(self):
                return 1

        self.assertFalse(sir.wait_until_ready(Exited(), 1, timeout=5))

    def test_stop_server_ignores_finished_process(self):
        class Finished:
            def poll(self):
                return 0

        with patch("suite_services.inspection_server.subprocess.run") as run:
            sir.stop_server(Finished())
            sir.stop_server(None)
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
