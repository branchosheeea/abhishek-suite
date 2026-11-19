# NeraVeda sign-in and access rights: admin guide

People sign in to NeraVeda with their Microsoft work account. An admin decides which workspaces each person may
open. Workspaces a person may not use are **hidden**: their cards, tiles, sidebar items and attention items do not
appear. All commands below run from the `Monthly Report Bot` folder with the suite's Python:

```powershell
.venv\Scripts\python.exe -m suite_services.access <command>
```

## Until it is set up: local mode

Until a PC has sign-in settings, NeraVeda runs exactly as before. It uses the Windows user, every workspace is
available, and the header says *"Sign-in not set up · all workspaces (local mode)"*. The web workspaces still need
NeraVeda to open them: opening `localhost:3000` / `3001` directly shows "Open from NeraVeda".

## 1. One-time preparation

1. **IT:** send [NERAVEDA_ACCESS_IT_REQUEST.md](NERAVEDA_ACCESS_IT_REQUEST.md) and receive the **Tenant ID** and
   **Client ID**.
2. **MongoDB Atlas.** In the project that holds the other NeraVeda databases, open **Database Access → Custom
   Roles** and create two roles on database `neraveda_access`:

   | Role | Actions |
   |---|---|
   | `neravedaAccessRead` | `find` on `users` and `meta` |
   | `neravedaAccessAdmin` | `find`, `insert`, `update` on `users` and `meta`; `find`, `insert` on `audit`; `createIndex`, `listIndexes` on `users`, `audit`, `meta`. **No** `remove` or drop. |

   Then create the database users:
   - `neraveda_access_ro` with `neravedaAccessRead`. Every PC gets this one.
   - `neraveda_access_admin_<yourname>` with `neravedaAccessAdmin`. Admin PCs only; one user per admin, so each can
     be revoked separately.

   Network access is the same as for the existing databases.
3. **On your PC (admin):**
   ```powershell
   .venv\Scripts\python.exe -m suite_services.access setup --admin
   .venv\Scripts\python.exe -m suite_services.access check
   .venv\Scripts\python.exe -m suite_services.access bootstrap --email you@goodwood… --name "Your Name"
   ```
   - `setup` asks for the tenant ID, the client ID, the DNS server (keep `8.8.8.8`: the office DNS cannot resolve
     Atlas), the read-only connection string and, with `--admin`, the admin connection string.
   - The connection strings are typed hidden and stored encrypted for your Windows account. They are never
     printed.
   - `check` must report the reader as *read-only (enforced by the database)* and the admin as *cannot delete;
     audit is insert-only*.
   - `bootstrap` creates you as the first admin with all workspaces. It is refused once an admin exists.
4. Open NeraVeda, click **Sign in with Microsoft**, then **Admin** (top right).

## 2. Adding people and changing rights

In **Admin**:
- **Add person** → the exact Microsoft sign-in name (work email) and name.
- Tick the workspaces, set **Active**, and optionally **Admin**.
- Write a reason, then **Save**.

Every change is stored with who made it, when, from which PC and which database user, and appears under *Recent
changes*.

- If someone else changed the same person meanwhile, saving is refused ("changed by someone else"). Reload and
  repeat.
- You cannot remove your own admin right, and the last admin cannot be removed.
- People are never deleted, only **deactivated**, so the history stays complete.

**When changes take effect:**
- Removed workspaces disappear within **15 minutes** while NeraVeda is open. Open browser tabs of a removed web
  workspace lose their session.
- Added workspaces appear after the person restarts NeraVeda.
- A deactivated person is signed out at the next check.

## 3. Colleagues' PCs

1. Install the suite as usual (Python, `pip install -r requirements.txt`, `npm install` in the web app folders).
2. Run `setup` (without `--admin`) with the **read-only** connection string, then `check`.
3. Add the person in Admin **before** they sign in. Otherwise they see *"… is not registered in NeraVeda"*, with
   the exact sign-in name to give you.

## 4. Make sign-in mandatory

Once every PC is set up, set `"required": true` in `suite_services/access/policy.json` in the shared code folder.
From then on, a PC without sign-in settings opens nothing (no local mode).

## 5. Database passwords out of the code folder

Today the Inspection and Emissions apps read their MongoDB passwords from `.env.local` files in their folders. Those
files travel with every copy of the code. To keep the passwords off colleagues' PCs unless they need them:

```powershell
.venv\Scripts\python.exe -m suite_services.access secrets import
```

- This copies `MONGODB_URI` (Inspection) and the `EMISSIONS_*` connection settings into encrypted storage on this
  PC, then lists which lines to delete from each `.env.local`. It does not edit the files itself.
- After you delete those lines, NeraVeda passes the settings to a server only when it starts it, and only for
  people who have that workspace.
- On a colleague's PC, enter them with `secrets set sir` or `secrets set evi`, and only if they have that
  workspace. Better still, give each person their own Atlas user.
- The Emissions test command `npm run test:mongo` keeps using `EMISSIONS_TEST_MONGODB_URI`.

## 6. When someone leaves

1. **Deactivate** them in Admin. They are signed out within 15 minutes.
2. IT disables the Microsoft account.
3. Change the passwords of any shared database users they held (Inspection/Emissions users, and the read-only
   access-list user if they had it), then update them with `setup` / `secrets set` on the remaining PCs.

## Everyday behaviour

- **Sign out** (top right) closes NeraVeda and stops the Inspection/Emissions servers. Workspace windows that are
  already open stay open until closed.
- **Offline:** if the access list cannot be reached, NeraVeda keeps working with the last-checked rights for up to
  **72 hours**, and the header says so. A session lasts 12 hours, then renews silently.
- **Desktop workspaces** started directly (e.g. `python -m lube_oil`) open only with a valid NeraVeda session that
  includes them. Otherwise they offer to open NeraVeda.
- **Web workspaces:** if a server is already running from an earlier session, NeraVeda asks to restart it so it can
  sign you in. Inspection drafts in the browser and Emissions sessions are kept.

## Checks

| Command | Shows |
|---|---|
| `check` | settings present, Microsoft reachable, what each database credential can really do |
| `whoami` | who is signed in on this PC, their workspaces and session time left (no tokens) |
| `webcheck sir` / `webcheck evi` | with the server running from NeraVeda: the web workspace refuses requests without a session, from other hosts, and without the write header; the session works; revoking ends it |

## Limits: what this does and does not protect

Read [NERAVEDA_ACCESS.md](NERAVEDA_ACCESS.md#limitations). In short:
- It reliably stops casual or accidental use and records who did what.
- It is **not** a barrier against a colleague who edits the code on their own PC.
- The database permissions and Microsoft sign-in are enforced outside the PC.
