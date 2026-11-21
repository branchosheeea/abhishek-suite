# NeraVeda sign-in and access rights: admin guide

An admin decides which workspaces each person may open. Workspaces a person may not use are **hidden**: their cards,
tiles, sidebar items and attention items do not appear.

People can sign in in two ways. Both check the same list of people and rights:

| Method | Needs | Good for |
|---|---|---|
| **NeraVeda ID and password** | Only the Atlas setup below. The ID is the person's work email. | Starting now, without IT |
| **Microsoft work account** | IT's app registration ([request](NERAVEDA_ACCESS_IT_REQUEST.md)) | Later: Microsoft checks the password, with MFA, and IT blocks leavers |

- **Each PC** offers the methods set up on it.
- **Each person** can use Microsoft and, if you give them one, a NeraVeda password.
- **Moving to Microsoft later** keeps everything else as it is: the list, the rights and the history.

All commands below run from the `Monthly Report Bot` folder:

```powershell
.venv\Scripts\python.exe -m suite_services.access <command>
```

## Until it is set up: local mode

Until a PC has sign-in settings, NeraVeda runs exactly as before. It uses the Windows user, every workspace is
available, and the header says *"Sign-in not set up · all workspaces (local mode)"*. The web workspaces still need
NeraVeda to open them: opening `localhost:3000` / `3001` directly shows "Open from NeraVeda".

## 1. One-time preparation

1. **Python packages.** The NeraVeda shortcut runs on the installed Python, not on the project's `.venv`. Install
   the suite's packages into the Python the shortcut uses:
   ```powershell
   & "$env:LOCALAPPDATA\Python\pythoncore-3.15-64\python.exe" -m pip install -r requirements.txt
   ```
   This adds `pymongo` (the access list), `cryptography` (NeraVeda passwords) and `msal` (Microsoft sign-in).
   Without them the PC stays in local mode. `check` lists what is missing.
2. **MongoDB Atlas.** In the project that holds the other NeraVeda databases, open **Database Access → Custom
   Roles** and create two roles on database `neraveda_access`:

   | Role | Actions |
   |---|---|
   | `neravedaAccessRead` | `find` on `users` and `meta`; `find`, `insert` on `password_changes` |
   | `neravedaAccessAdmin` | `find`, `insert`, `update` on `users` and `meta`; `find`, `insert` on `audit`; `find` on `password_changes`; `createCollection`, `createIndex` on all four. **No** `remove` or drop anywhere. |

   In the Atlas form, tick only the individual action names. Ticking a group heading (such as *Query and Write
   Actions*) selects every action under it, including `remove` and drop.

   - **Why the read-only role can insert:** inserting into `password_changes` is how people choose their own
     password. Each change must be signed with the person's previous password, so nobody can set someone else's
     password this way.

   Then create the database users:
   - `neraveda_access_ro` with `neravedaAccessRead`. Every PC gets this one.
   - `neraveda_access_admin_<yourname>` with `neravedaAccessAdmin`. Admin PCs only; one user per admin, so each can
     be revoked separately.

   Network access is the same as for the existing databases.
3. **On your PC (admin):**
   ```powershell
   .venv\Scripts\python.exe -m suite_services.access setup --admin
   .venv\Scripts\python.exe -m suite_services.access check
   .venv\Scripts\python.exe -m suite_services.access bootstrap --email you@goodwood… --name "Your Name" --password
   ```
   - **`setup`** asks for:
     - The Microsoft tenant ID and client ID. **Press Enter to skip them** until IT sends them; the PC then offers
       ID and password only. Run `setup` again later to add them.
     - The DNS server. Keep `8.8.8.8`: the office DNS cannot resolve Atlas.
     - The read-only connection string and, with `--admin`, the admin connection string. They are typed hidden,
       stored encrypted for your Windows account, and never printed.
   - **`check`** must report:
     - the reader as *read-only for people and rights; can record people's own password changes*;
     - the admin as *cannot delete; audit is insert-only*.
   - **`bootstrap`** creates you as the first admin with all workspaces. `--password` asks for your own NeraVeda
     password (twice, hidden). Use it unless this PC already has Microsoft sign-in. It is refused once an admin
     exists.
4. Open NeraVeda, sign in with your work email and that password (or **Sign in with Microsoft**), then click
   **Admin** (top right).

## 2. Adding people and changing rights

In **Admin**:
1. Click **Add person** and enter their work email (their ID, and their Microsoft sign-in name) and their name.
2. Tick the workspaces, set **Active**, and optionally **Admin**.
3. For sign-in without Microsoft, click **Set temporary password**.
4. Write a reason, then **Save**.

After saving, NeraVeda shows the temporary password **once**. Give it to the person in person or by phone, not in
the same email as their ID. At first sign-in they must choose their own password: at least 12 characters, not
containing their ID. You never know their own password.

Every change is stored with who made it, when, from which PC and which database user, and appears under *Recent
changes*. Passwords appear there only as *password:temporary* or *password:removed*, never the password itself.

- If someone else changed the same person meanwhile, saving is refused ("changed by someone else"). Reload and
  repeat.
- You cannot remove your own admin right, and the last admin cannot be removed.
- People are never deleted, only **deactivated**, so the history stays complete.

**Passwords:**
- **Forgotten password:** select the person, **Set temporary password**, **Save**, and give them the new one. Their
  old password stops working, and any PC where they are signed in asks them to sign in again within 15 minutes.
- **Microsoft only:** click **Remove**, then **Save**. They can then sign in only with Microsoft.
- **Their own change:** people change their own password with **Change password** (top right, next to Sign out).
  No admin is needed.
- **The status line** shows whether a person has no password, a temporary one, or one they chose themselves.

**When changes take effect:**
- Removed workspaces disappear within **15 minutes** while NeraVeda is open. Open browser tabs of a removed web
  workspace lose their session.
- Added workspaces appear after the person restarts NeraVeda.
- A deactivated person is signed out at the next check.

## 3. Colleagues' PCs

1. Install the suite as usual: Python with `pip install -r requirements.txt` for the Python the shortcut uses, and
   `npm install` in the web app folders.
2. Run `setup` (without `--admin`) with the **read-only** connection string, then `check`.
3. Add the person in Admin **before** they sign in, with a temporary password if they will use one.
   - **Microsoft sign-in, not yet added:** they see *"… is not registered in NeraVeda"*, with the exact sign-in
     name to give you.
   - **ID and password:** a wrong password and an unknown ID both get the same message, *"The NeraVeda ID or
     password is not correct"*.

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

1. **Deactivate** them in Admin. They are signed out within 15 minutes, whichever way they signed in.
2. If they use Microsoft sign-in, IT disables the Microsoft account.
3. Change the passwords of any shared database users they held (Inspection/Emissions users, and the read-only
   access-list user if they had it), then update them with `setup` / `secrets set` on the remaining PCs.

## Everyday behaviour

- **Sign out** (top right) closes NeraVeda and stops the Inspection/Emissions servers. Workspace windows that are
  already open stay open until closed.
- **Change password** (top right) appears for people signed in with a NeraVeda password. Other PCs where they are
  signed in ask them to sign in again.
- **Wrong passwords:** after 5 wrong passwords on a PC, NeraVeda waits 1 minute before the next try, then longer
  with each further wrong try (up to 15 minutes).
- **Offline:** if the access list cannot be reached, NeraVeda keeps working with the last-checked rights for up to
  **72 hours**, and the header says so. A session lasts 12 hours. A Microsoft session then renews silently; a
  password session asks for the password again.
- **Desktop workspaces** started directly (e.g. `python -m lube_oil`) open only with a valid NeraVeda session that
  includes them. Otherwise they offer to open NeraVeda.
- **Web workspaces:** if a server is already running from an earlier session, NeraVeda asks to restart it so it can
  sign you in. Inspection drafts in the browser and Emissions sessions are kept.

## Checks

| Command | Shows |
|---|---|
| `check` | settings, sign-in methods on this PC, missing Python packages, what each database credential can really do |
| `whoami` | who is signed in on this PC, how, their workspaces and session time left (no tokens) |
| `webcheck sir` / `webcheck evi` | with the server running from NeraVeda: the web workspace refuses requests without a session, from other hosts, and without the write header; the session works; revoking ends it |

## Limits: what this does and does not protect

Read [NERAVEDA_ACCESS.md](NERAVEDA_ACCESS.md#limitations). In short:
- It reliably stops casual or accidental use and records who did what.
- It is **not** a barrier against a colleague who edits the code on their own PC.
- **NeraVeda passwords are checked on the PC.** Every PC can read the stored password checks, so someone determined
  could try to guess weak passwords offline. Hence the 12-character minimum, and people should not reuse their
  Windows or Microsoft password.
- Microsoft sign-in is stronger: Microsoft checks the password, MFA applies, and IT disables leavers.
- The database permissions are enforced outside the PC.
