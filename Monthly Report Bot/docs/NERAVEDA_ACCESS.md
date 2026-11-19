# NeraVeda sign-in and access control: technical reference

How NeraVeda knows who is using it, which workspaces they may open, and how the desktop and web workspaces enforce
that. For day-to-day administration see [NERAVEDA_ADMIN_GUIDE.md](NERAVEDA_ADMIN_GUIDE.md). For the Entra app
registration see [NERAVEDA_ACCESS_IT_REQUEST.md](NERAVEDA_ACCESS_IT_REQUEST.md).

## Overview

```
 Microsoft Entra ID ──(MSAL, User.Read)──►  Launcher (abhishek_automation_suite.py)
   or NeraVeda ID + password (passwords.py) ─┤
                                              │  AccessService  (suite_services/access/session.py)
 Atlas: neraveda_access ◄──read-only URI──────┤     ├─ session.bin   (DPAPI, read by desktop modules)
   users / audit / meta  ◄──admin URI (admins)┤     └─ web_{sir,evi}.bin (DPAPI, per-server-run secret)
                                              │
              ┌───────────────────────────────┼─────────────────────────────────┐
              ▼                               ▼                                 ▼
   Desktop modules                    Inspection web app (3000)          Emissions web app (3001)
   require_module(key)                NERAVEDA_WEB_SECRET in env          NERAVEDA_WEB_SECRET in env
   reads session.bin                  /api/auth/enter → cookie            /api/auth/enter → cookie
                                      route() checks every API call       route() checks every API call
```

Only the launcher signs in. Desktop modules read the session the launcher wrote. Web workspaces trust tickets
signed with a secret that only the launcher and that server run hold.

## Code map

| Area | Files |
|---|---|
| DPAPI storage | `suite_services/secure_store.py` (`protect`, `unprotect`, `write_protected`, `read_protected`, `remove`; purpose string as entropy; crypt32 called through ctypes, so no pywin32 is needed on the Python the shortcut uses) |
| Audit identity | `suite_services/actor.py` (`current_actor()`: signed-in email, else the Windows user) |
| Settings | `suite_services/access/config.py`, `policy.json` |
| Rights model | `suite_services/access/entitlements.py` (pure) |
| Access list | `suite_services/access/store.py` (`AccessStore` on pymongo, `MemoryAccessStore` for tests) |
| Microsoft sign-in | `suite_services/access/signin.py` (`EntraSignIn`) |
| NeraVeda passwords | `suite_services/access/passwords.py` (verifiers, rules, signed change chain) |
| Session and launcher API | `suite_services/access/session.py` (`Session`, `SessionStore`, `AccessService`) |
| Tickets | `suite_services/access/tickets.py`; Node twin in each app's `lib/server/auth.ts` |
| Desktop guard | `suite_services/access/guard.py` (`require_module`) |
| UI | `suite_services/access/ui.py` (`SignInPanel`, `AdminWindow`) |
| CLI | `suite_services/access/__main__.py` (`setup`, `secrets`, `check`, `bootstrap`, `whoami`, `webcheck`) |
| Test double | `suite_services/access/testing.py` (`FakeAccess`) |
| Web enforcement | `<app>/lib/server/http.ts` (`guard`, `route`), `<app>/lib/server/auth.ts`, `<app>/app/api/auth/{enter,session,revoke}/route.ts` |
| Web client | Emissions `components/api.ts`; Inspection `lib/api.ts` (`apiFetch`); both `components/shell/session-gate.tsx` |

## Settings and modes

`load_config()` builds an `AccessConfig` from three sources. Environment variables win, which keeps tests and one-off
checks simple.

| Value | Environment | Stored |
|---|---|---|
| Tenant ID, client ID, DNS servers, database name | `NERAVEDA_TENANT_ID`, `NERAVEDA_CLIENT_ID`, `NERAVEDA_DNS_SERVERS`, `NERAVEDA_ACCESS_DB` | `<runtime_root>/access/config.json` |
| Read-only / admin access-list URI | `NERAVEDA_ACCESS_URI`, `NERAVEDA_ACCESS_ADMIN_URI` | `<runtime_root>/access/reader_uri.bin`, `admin_uri.bin` (DPAPI) |
| Inspection / Emissions database settings | (none) | `<runtime_root>/access/db_sir.bin`, `db_evi.bin` (DPAPI, JSON) |
| Sign-in required | (none) | `suite_services/access/policy.json` in the code folder |

- **Configured** means the read-only URI is present. The PC then offers NeraVeda ID and password sign-in.
- **Microsoft** is available when it is configured and the tenant and client IDs are both present as well.
  `setup` accepts both IDs or neither.
- **Local mode** means not configured and `required` is false. The Windows user then gets every module, which is
  how the suite behaved before.
- If `policy.json` cannot be read, sign-in counts as required. An unreadable file never weakens access.
- **Not set up** means not configured while `required` is true. Nothing opens.

## Microsoft sign-in

`EntraSignIn` uses an MSAL public client for the configured tenant, with the scope `User.Read` only. The token cache
is DPAPI-protected. Sign-in tries these in order:

1. Silent sign-in from the cache.
2. The Windows broker, only if `pymsalruntime` is installed. It is optional, and there is no wheel for Python 3.15
   yet.
3. The system browser, with a `http://localhost` redirect.
4. A device code, shown in the sign-in panel.

The resulting `Identity` holds `email` (lower-cased `preferred_username`), `oid`, `tid` and `name`. If `tid` is not the
configured tenant, sign-in is refused.

## NeraVeda ID and password

The ID is the person's email in the access list. `passwords.py` has the details.

**What is stored.** `users.password = {verifier, epoch, temporary, set_at, set_by}` is written only with the admin
credential. The verifier `{alg: "scrypt-ed25519", n, r, p, salt, pub}` holds no password:
- `seed = scrypt(NFKC(password), salt, n=2^16, r=8, p=1)`. That is 64 MB of memory and about 0.3 s per check.
- `pub` is the Ed25519 public key for that seed.
- Checking a password means deriving `pub` again and comparing it in constant time.
- Accepted costs are bounded (`n` ≤ 2^18, `r` ≤ 8), so a planted record cannot make a PC spend gigabytes.

**Temporary passwords.** An admin sets one: 16 random characters, shown once. Signing in with it raises
`PasswordChangeRequired`, and no session is written until the person has chosen their own password.

**People's own changes.** People change their own password without an admin credential:
- A change is a record in `password_changes`: `{email, epoch, seq, verifier, prev, at, sig}`.
- It is signed with the private key derived from the **previous** password. The read-only role may insert into
  `password_changes`, but cannot update or remove there.
- Every PC rebuilds the current password with `resolve()`: start from `users.password`, then repeatedly take a
  record with the next `seq`, the same `epoch` and `prev` equal to the current `pub`, whose signature verifies with
  the current `pub`. If several qualify, the lowest `(at, sig)` wins, so every PC reaches the same result.
- A planted, edited or replayed record does not verify against the current key, so it is ignored. Nobody can set
  another person's password, even with direct database access.
- An admin reset writes a new `users.password` with `epoch + 1`, which ends the old chain.

**Rules.** A new password needs at least 12 characters and at least 5 different characters. It must not contain the
ID's local part, must not be on a short list of common passwords, and must differ from the current one.

**Answers and attempts.**
- An unknown ID, a person without a password, and a wrong password all get the same answer: *"The NeraVeda ID or
  password is not correct"*. They also take the same time (`passwords.spend()` runs the same scrypt), so response
  timing does not show which IDs exist.
- Deactivation is reported only after the right password.
- After 5 wrong attempts within 30 minutes, the launcher waits 60 s, then doubles the wait up to 15 minutes. This
  limit is in memory on that PC.

**Package.** Ed25519 comes from `cryptography`, a dependency of `msal` that is also listed in `requirements.txt`.
Without it, `passwords.available()` is false and Admin says so. Local mode never needs it.

## Access list (`neraveda_access`)

| Collection | Content | Written by |
|---|---|---|
| `users` | `{email (unique, lower-case), oid (unique when set), name, active, admin, grants: [{module, role: "use"}], password (or null), note, rev, created_at/by, updated_at/by}` | admin URI only |
| `audit` | `{at, actor {email, oid, name}, db_user, action, target, rev, before, after, changes ["+oil", "-sir", "admin:false→true", "password:temporary"], reason, client {host, windows_user, app_version}}`. `before`/`after` record a password's state only (epoch, temporary, set_at/by), never the verifier. | admin URI, insert only |
| `meta` | `{_id: "policy", session_hours: 12, offline_grace_hours: 72, refresh_minutes: 15, rev}` | admin URI |
| `password_changes` | people's own changes, signed with their previous password (above); index `email, epoch, seq`, not unique, so a planted record can never block a real change | read-only URI, insert only |

- **Saves** (`AccessStore.save_user`) update the user only where `rev` is still the value the admin loaded, and
  write the audit entry in the same transaction. If `rev` changed, `ConflictError` is raised. If the save would
  leave no active admin, `LastAdminError` is raised.
- **People are never deleted**, only deactivated.
- **The database enforces the limits.** The Atlas custom roles (admin guide §1) give the read-only user `find` only,
  and give admin users no `remove` or drop. `AccessStore.privileges()` reads `connectionStatus` with
  `showPrivileges`, which lets `check` report what a credential can really do.
- **Matching:** a person is matched by email. If `oid` is stored, it must also match.
- **DNS:** `apply_dns_override` points the SRV lookup at the configured DNS servers (`8.8.8.8`), because the office
  DNS cannot resolve Atlas.

Module keys (`entitlements.MODULES`) are the launcher's workspace keys. `allows(access, module)` is the single
decision point. Roles beyond `use` (view < edit < approve) and vessel scopes are reserved in the model, but v1 does
not use them.

## Session

After sign-in and the access-list lookup, `AccessService` writes `session.bin` (DPAPI) with email, name, oid, admin,
modules, `mode` (`entra` or `password`), `signed_in_at`, `verified_at` and the policy values. For password sessions it
also writes `credential` (the epoch, sequence number and key of the password used). A session is valid while:

```
now < signed_in_at + session_hours          (12 h, then a silent re-sign-in)
now < verified_at  + offline_grace_hours    (72 h without reaching the access list)
```

- **Refresh:** while the launcher runs, it re-checks the access list every `refresh_minutes` (15).
- **Rights removed:** the launcher hides those modules at once and revokes their browser sessions. New entry tickets
  carry no grant for them, so the web workspace answers 403.
- **Rights added:** they appear after a restart.
- **Deactivated or missing person:** that person is signed out at the next check.
- **Password reset or changed elsewhere:** if the password now in force is no longer the one in `credential`, a
  password session ends at the next check. The cause can be an admin reset, the person's change on another PC, or
  password sign-in being removed. A change made on this PC updates `credential`.
- **After 12 hours:** a Microsoft session renews silently, while a password session asks for the password again.

## Desktop modules

Each module's `__main__` calls `require_module("<key>")` inside `if __name__ == "__main__":`:
`vessel_report`, `lube_oil`, `voyage_summary`, `gc_manager`, `Critical Jobs Compliance`. `launch_app.pyw --reports`
goes through `runpy.run_module("vessel_report")`, so it is guarded too.

The guard reads `session.bin` and exits with code 2 if the module is not allowed. It first shows a Windows message
box, which offers to open NeraVeda when nobody is signed in. Modules never sign in themselves.

**Audit fields** such as created_by and approved_by use `actor.current_actor()`, which is the signed-in email.
`gc_manager` uses `GC_LOCAL_USER_NAME` if set (tests), then the signed-in email, then its stored setting.

## Web workspaces

### Secret

Each time the launcher starts a web server, it generates a fresh 32-byte secret (64 hex characters) and stores it
DPAPI-protected as `credentials/web_{sir,evi}.bin`. It passes the secret to the server only in the
`NERAVEDA_WEB_SECRET` environment variable, never on the command line or in the log. The database settings for that
workspace travel the same way, and only if the person has that workspace (`AccessService.db_env`). Next.js does not
override variables that are already in the environment.

Without a valid secret (`/^[0-9a-f]{64,}$/i`), every API route answers **503** "This workspace must be opened from
NeraVeda".

### Tickets

The same format is used in Python (`tickets.py`) and Node (`lib/server/auth.ts`). The shared test vectors are in
`tests/fixtures/neraveda_ticket_vectors.json`.

```
nv1.<b64url(JSON payload)>.<b64url(HMAC-SHA256(secret, "nv1." + b64url(JSON payload)))>

payload = { typ: "enter" | "service" | "session", aud: "sir" | "evi", sub: email, name, adm,
            grants: [{module, role}]  (this workspace only), iat, exp, jti }
```

`b64url` is unpadded. Verification compares the MAC in constant time, then checks `typ`, `aud`, an integer `exp` that
has not passed, and a non-empty `sub`.

| Ticket | Lifetime | Issued by | Used for |
|---|---|---|---|
| `enter` | 120 s | launcher | the URL the browser opens: `/api/auth/enter?t=…&next=…` |
| `service` | 60 s | launcher | header `x-neraveda-service`, for the Home summary, `session` and `revoke` |
| `session` | 12 h | web server | the cookie `neraveda_sir` / `neraveda_evi` |

### Entering

`GET /api/auth/enter` verifies the enter ticket and requires a grant for this workspace. It then signs a session
ticket and answers **303** to `next`, with:

```
Set-Cookie: neraveda_<app>=<session>; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200
```

- `next` must be a same-origin path. It must not start with `//`, contain backslashes, whitespace or control
  characters, or start with `/api/`. Anything else falls back to the default (`/inspections` or `/`).
- The redirect is relative, so the browser stays on `http://localhost:<port>`. The Inspection drafts in IndexedDB
  belong to that exact origin.
- Errors are small HTML pages: expired link, no access, or not started by NeraVeda.

### Every API request

`route({mutating, limit?, auth})` in `lib/server/http.ts` runs these checks in order:

1. **`guard`:**
   - The `Host` must be this machine and port (this defeats DNS rebinding).
   - A cross-site `Sec-Fetch-Site` or a foreign `Origin` is refused.
   - Mutating requests must carry `x-neraveda-request: 1`, which a cross-origin page cannot send without a preflight
     that is never approved.
   - Any failure answers **403**.
2. **`authenticate(req, auth)`**, by mode:
   - `user`: a session cookie with a grant for this workspace.
   - `user-or-service`: as `user`, or a service ticket instead.
   - `service`: a service ticket only.
   - `none`: used only for `enter`.
   - A missing or invalid credential answers 401; a missing grant answers 403.
3. **The handler** runs inside `withUser(claims)`. An AsyncLocalStorage then makes `currentUser()` available
   everywhere below it, without passing it through every service.
   - In Emissions, `runtime.ts actor()` uses it, so audit entries record the signed-in email.
   - Inspection reports do not store who saved them yet.

The health route is the only API route outside `route()`. A static test checks that every other route uses it.

Pages are not checked on the server, because the Inspection service worker caches pages. Instead, the client
`SessionGate` asks `/api/auth/session` and shows a lock panel on 401/403/503 ("Open this workspace from NeraVeda").
`apiFetch` and the Emissions `api` helper raise the same event on those codes.

- **Inspection offline:** a network error is not a lock. It shows an "offline" banner, and offline drafts keep
  working.
- **Inspection editor:** a 401/403/503 no longer leads to an empty draft being created over a report that could not
  be loaded.

### Revoking

- `POST /api/auth/revoke` (service ticket) sets an in-memory "not before" time. Session cookies issued at or before
  it answer 401.
- The launcher calls it when the person signs out or loses the workspace.
- A server restart rotates the secret, which invalidates every earlier ticket.

### Old servers

A server started before this launcher session does not accept the current secret (`server_accepts` gets no 200 from
`/api/auth/session`). The launcher then asks before stopping it. `stop_listener(port)` stops only a `node.exe`
listening on that port, together with its `next` parent, and leaves any other program alone. The launcher then
starts the server again with a new secret.

### Other headers

Inspection `next.config.mjs` adds:
- `X-Frame-Options: SAMEORIGIN`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `poweredByHeader: false`

The Emissions app already sent its equivalents.

## Tests

| Suite | Command | Access-related files |
|---|---|---|
| Python | `.venv\Scripts\python.exe -m unittest discover -s tests` | `tests/test_access_core.py` (incl. passwords: verifiers, rules, planted/replayed changes, temporary flow, attempt limit, reset), `tests/test_access_launcher.py`; launcher tests use `AutomationSuite(access=FakeAccess())` |
| Emissions | `npm test` in `Emission Correction Assitant` | `tests/auth.test.ts` |
| Inspection | `npm test` in `Superintendent inspection Report` | `tests/auth.test.ts` |
| End to end | `python -m suite_services.access webcheck sir\|evi` (server started from NeraVeda) | 9 checks: health, no session, entry, cookie, write header, foreign host, service ticket with and without, revoke |

Both Node suites and the Python suite verify the same ticket vectors, so a change to the format in one language fails
the other two.

## Limitations

These checks run on each person's PC, in code that person holds. Someone who can edit that code, or read their own
DPAPI-protected files, can bypass them on their own PC. That includes the guard, the hidden modules and the web
secret.

What this design does:
- It reliably stops casual and accidental use.
- It attributes every action to a signed-in person.

NeraVeda passwords add these limits:
- **Offline guessing:** every PC can read the stored verifiers, because each PC checks passwords itself. Someone
  with the read-only credential could try to guess weak passwords offline. scrypt makes each guess cost about
  0.3 s and 64 MB, and the 12-character rule keeps reasonable passwords out of reach. People should still not reuse
  their Windows or Microsoft password.
- **Online guessing:** the wrong-attempt wait applies only within the launcher on one PC. Edited code avoids it.
- **No MFA, and no automatic leaver handling:** deactivate leavers in Admin.
- **Planted records:** a holder of the read-only credential can insert junk into `password_changes`. It is ignored,
  and it cannot change anyone's password.

What is enforced outside the PC:
- **Microsoft sign-in:** only company accounts can sign in, with MFA and Conditional Access. If IT sets *Assignment
  required*, only assigned people can sign in at all.
- **Password changes:** only someone who knows a person's current password can change it. The signature makes this
  hold even for someone with direct database access.
- **Atlas roles:**
  - The read-only credential cannot change the access list.
  - Admin credentials cannot delete people or audit entries.
  - Nobody can grant themselves rights without an admin credential.
- **Database passwords:** after `secrets import` and removing the lines from `.env.local`, the Inspection and
  Emissions passwords no longer travel with the code. A PC holds them only if someone entered them there.
  Per-person Atlas users let you revoke one person's database access without touching anyone else.

What it does not do:
- **Shared database users:** anyone holding the password of a shared Inspection or Emissions database user can reach
  that data directly, whatever the access list says. When a person leaves, rotate those passwords (admin guide §6).
- **Instant revocation:** a removed right is enforced within 15 minutes while NeraVeda is online. Offline, a cached
  session keeps working for up to 72 hours.
- **Separation between people on one PC:** two people sharing one Windows account share one NeraVeda session.

The lasting fix is a central server that validates Microsoft tokens itself and holds the database credentials, so
nothing sensitive is on the PCs. The ticket format, the `route()` checks and the access-list model carry over to that
design unchanged.
