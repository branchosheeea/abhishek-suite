"""NeraVeda access set-up and checks:  python -m suite_services.access <command>

  setup [--admin]        store this PC's sign-in settings (tenant, client, DNS) and the access-list connection(s)
  secrets import         move the Inspection/Emissions database settings from the apps' .env.local into protected storage
  secrets set sir|evi    enter those database settings by hand (for a colleague's PC)
  check                  configuration, Microsoft reachability, database permissions (prints no secrets)
  bootstrap --email E --name N   create the first admin (admin PC only; refused once an admin exists)
  whoami                 who is signed in on this PC and to what (no tokens)
  webcheck sir|evi       end-to-end checks of a running web workspace's access control
"""
from __future__ import annotations

import argparse
import getpass
import json
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from suite_services.access import config as cfg
from suite_services.access.session import DB_VARS, AccessService, SessionStore

MRB = Path(__file__).resolve().parents[2]
ENV_FILES = {"sir": MRB / "Superintendent inspection Report" / ".env.local", "evi": MRB / "Emission Correction Assitant" / ".env.local"}
PORTS = {"sir": 3000, "evi": 3001}


def _ask(prompt: str, secret: bool = False, default: str | None = None) -> str:
    label = f"{prompt}{f' [{default}]' if default else ''}: "
    value = getpass.getpass(label) if secret else input(label)
    return value.strip() or (default or "")


def cmd_setup(args) -> int:
    current = cfg.load_config()
    tenant = _ask("Directory (tenant) ID", default=current.tenant_id)
    client = _ask("Application (client) ID", default=current.client_id)
    dns = _ask("DNS servers for MongoDB SRV lookups (comma-separated)", default=",".join(current.dns_servers) or "8.8.8.8")
    cfg.save_settings(tenant, client, [d.strip() for d in dns.split(",") if d.strip()])
    reader = _ask("Access-list READ-ONLY connection string (hidden; Enter keeps the current one)", secret=True)
    if reader:
        cfg.save_secret("reader_uri", reader)
    if args.admin:
        admin = _ask("Access-list ADMIN connection string (hidden; Enter keeps the current one)", secret=True)
        if admin:
            cfg.save_secret("admin_uri", admin)
    print("Saved. Run: python -m suite_services.access check")
    return 0


def _parse_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def cmd_secrets(args) -> int:
    if args.action == "import":
        for key, path in ENV_FILES.items():
            if not path.is_file():
                print(f"{key}: {path.name} not found — nothing to import")
                continue
            found = {k: v for k, v in _parse_env(path).items() if k in DB_VARS[key] and v}
            if not found:
                print(f"{key}: no database settings in {path}")
                continue
            cfg.save_secret(f"db_{key}", json.dumps(found))
            print(f"{key}: stored {', '.join(sorted(found))} in protected storage.")
            print(f"     Now delete these lines from {path} (NeraVeda passes them to the server when it starts it):")
            for name in sorted(found):
                print(f"       {name}=…")
        return 0
    key = args.key
    if key not in DB_VARS:
        print("Choose sir or evi.")
        return 2
    values = {}
    for name in DB_VARS[key]:
        value = _ask(f"{name} (hidden; Enter to skip)", secret=name.endswith("URI"))
        if value:
            values[name] = value
    if not values:
        print("Nothing entered; unchanged.")
        return 1
    cfg.save_secret(f"db_{key}", json.dumps(values))
    print(f"{key}: stored {', '.join(sorted(values))} in protected storage.")
    return 0


def _https_check(url: str) -> str:
    try:
        with urllib.request.urlopen(url, timeout=8) as response:
            return f"reachable (HTTP {response.status})"
    except urllib.error.URLError as error:
        if isinstance(error.reason, ssl.SSLError):
            return "TLS certificate not trusted — HTTPS inspection? Install 'truststore' or ask IT to exclude login.microsoftonline.com"
        return f"NOT reachable ({error.reason})"
    except OSError as error:
        return f"NOT reachable ({error})"


def cmd_check(_args) -> int:
    from suite_services.access.signin import broker_available
    c = cfg.load_config()
    print(f"Policy: sign-in {'REQUIRED' if c.required else 'not required yet'} (suite_services/access/policy.json)")
    print(f"Mode on this PC: {'local (Windows user, all workspaces)' if c.local_mode else 'Microsoft sign-in' if c.configured else 'NOT SET UP — workspaces will not open'}")
    print(f"Tenant ID: {'set' if c.tenant_id else 'missing'} · Client ID: {'set' if c.client_id else 'missing'} · DNS: {', '.join(c.dns_servers) or 'system'}")
    print(f"Access list: read-only connection {'set' if c.reader_uri else 'missing'} · admin connection {'set' if c.admin_uri else 'not on this PC'}")
    print(f"Windows sign-in broker: {'available' if broker_available() else 'not installed (browser sign-in is used)'}")
    if c.tenant_id:
        print(f"Microsoft sign-in endpoint: {_https_check(f'https://login.microsoftonline.com/{urllib.parse.quote(c.tenant_id)}/v2.0/.well-known/openid-configuration')}")
    status = 0
    for label, uri in (("reader", c.reader_uri), ("admin", c.admin_uri)):
        if not uri:
            continue
        try:
            from suite_services.access.store import AccessStore
            store = AccessStore(uri, c.db_name, c.dns_servers)
            p = store.privileges()
            print(f"Access list ({label}, database user {p['user']}): {p['summary']}")
            if label == "reader" and (p["can_write"] or p["can_remove"]):
                print("  WARNING: the read-only connection can change the access list. Use a user with the neravedaAccessRead role.")
                status = 1
            store.close()
        except Exception as error:
            print(f"Access list ({label}): NOT reachable — {error}")
            status = 1
    for key in DB_VARS:
        print(f"{key} database settings in protected storage: {'yes' if cfg.read_secret(f'db_{key}') else 'no'}")
    return status


def cmd_bootstrap(args) -> int:
    c = cfg.load_config()
    if not c.admin_uri:
        print("This PC has no admin connection. Run: python -m suite_services.access setup --admin")
        return 2
    from suite_services.access.store import AccessStore
    store = AccessStore(c.admin_uri, c.db_name, c.dns_servers)
    person = store.bootstrap_admin(args.email, args.name)
    print(f"First admin created: {person.email} (all workspaces). Indexes and policy are in place.")
    return 0


def cmd_whoami(_args) -> int:
    c = cfg.load_config()
    if c.local_mode:
        print("Local mode: sign-in is not set up; the Windows user has every workspace.")
        return 0
    s = SessionStore().load()
    if s is None:
        print("Nobody is signed in on this PC.")
        return 1
    left = (s.expires_at - time.time()) / 3600
    print(f"{s.name} <{s.email}> · {'admin · ' if s.admin else ''}workspaces: {', '.join(s.modules) or 'none'}")
    print(f"Session {'valid' if s.valid(time.time()) else 'EXPIRED'} ({left:.1f} h left) · last checked {time.strftime('%Y-%m-%d %H:%M', time.localtime(s.verified_at))}")
    return 0


def _request(url: str, headers: dict | None = None, method: str = "GET", data: bytes | None = None) -> tuple[int, dict]:
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *a, **k):
            return None
    opener = urllib.request.build_opener(NoRedirect)
    request = urllib.request.Request(url, headers=headers or {}, method=method, data=data)
    try:
        # The first authenticated report request may initialize the Mongo connection and indexes.
        # Give that startup path time to finish instead of turning a successful slow response into
        # a false webcheck failure.
        with opener.open(request, timeout=45) as response:
            return response.status, dict(response.headers)
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers)


def cmd_webcheck(args) -> int:
    key = args.key
    port = PORTS[key]
    access = AccessService.from_config()
    if access.cached() is None:
        print("Sign in to NeraVeda first (the check uses this PC's session).")
        return 2
    base = f"http://localhost:{port}"
    protected = "/api/reports" if key == "sir" else "/api/sessions"
    summary = "/api/inspections/summary" if key == "sir" else "/api/summary"
    results: list[tuple[str, bool, str]] = []

    def expect(label, got, want):
        results.append((label, got == want, f"{got} (expected {want})"))

    expect("health", _request(f"{base}/api/health")[0], 200)
    expect("API without a session", _request(f"{base}{protected}")[0], 401)
    status, headers = _request(access.web_entry_url(key, port, "/"))
    expect("entry ticket", status, 303)
    cookie = (headers.get("Set-Cookie") or headers.get("set-cookie") or "").split(";")[0]
    expect("API with the session cookie", _request(f"{base}{protected}", {"Cookie": cookie})[0], 200)
    write = "/api/reports/check-0000" if key == "sir" else "/api/sessions"
    expect("write without the request header", _request(f"{base}{write}", {"Cookie": cookie, "Content-Type": "application/json"}, "PUT" if key == "sir" else "POST", b"{}")[0], 403)
    expect("foreign Host header", _request(f"{base}{protected}", {"Cookie": cookie, "Host": f"evil.example:{port}"})[0], 403)
    expect("summary with a service ticket", _request(f"{base}{summary}", access.service_headers(key))[0], 200)
    expect("summary without a ticket", _request(f"{base}{summary}")[0], 401)
    access.revoke_web(key, port)
    expect("old cookie after revoke", _request(f"{base}{protected}", {"Cookie": cookie})[0], 401)
    for label, ok, detail in results:
        print(f"{'PASS' if ok else 'FAIL'}  {label}: {detail}")
    print("Reopen the workspace from NeraVeda to get a new session in the browser.")
    return 0 if all(ok for _, ok, _ in results) else 1


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m suite_services.access", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("setup")
    p.add_argument("--admin", action="store_true")
    p.set_defaults(func=cmd_setup)
    p = sub.add_parser("secrets")
    p.add_argument("action", choices=["import", "set"])
    p.add_argument("key", nargs="?", choices=["sir", "evi"])
    p.set_defaults(func=cmd_secrets)
    sub.add_parser("check").set_defaults(func=cmd_check)
    p = sub.add_parser("bootstrap")
    p.add_argument("--email", required=True)
    p.add_argument("--name", required=True)
    p.set_defaults(func=cmd_bootstrap)
    sub.add_parser("whoami").set_defaults(func=cmd_whoami)
    p = sub.add_parser("webcheck")
    p.add_argument("key", choices=["sir", "evi"])
    p.set_defaults(func=cmd_webcheck)
    args = parser.parse_args(argv)
    if args.command == "secrets" and args.action == "set" and not args.key:
        parser.error("secrets set needs sir or evi")
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
