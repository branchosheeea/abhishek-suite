# Guarantee Claims Command Centre (web)

The Guarantee Claim Manager runs as the **Guarantee Claims** workspace in the NeraVeda web app. Open it from the NeraVeda launcher with **Command Centre (web)** on the Guarantee Claims tile, or from the web app's left menu. The old desktop GC Manager window still works and uses the same database.

## How it works
- **Rules and data:** the web pages call a Python helper (`gc_manager/service.py`) that the web server starts by itself. It does not open a network port. All claim rules stay in Python:
  - shared rules: `gc_manager/command.py`
  - email suggestions: `gc_manager/suggest.py`
  - changes: `gc_manager/web_actions.py` through `Repository`
- **Changes:** every change from the web keeps the same status history and audit as the desktop window, under the signed-in person's name.
  - A change is refused if the claim was changed elsewhere after the page loaded it.
- **Outlook sync:** the helper syncs every *graph_sync_interval_minutes* (default 5) while the web server runs (`gc_manager/sync.py`).
  - Only one sync runs at a time on this PC, even when the desktop window is open too.
  - The page header shows the last completed sync, a failure, or "sign-in needed". **Sign in to Microsoft** shows the device code on the page.
  - Access is unchanged: the same app registration, read-only `Mail.Read`, and the same encrypted token cache.
- **Database:** schema version 3 added `gc_claims.next_action`, `gc_claims.action_since` and the tables `gc_suggestions`, `gc_snoozes` and `gc_review_marks`. All are additions; a backup was taken automatically before they were added.

## Going back to the older version
If you decide to go back to the GC Manager code from before the web Command Centre (commit `4de05e0`):

1. Close NeraVeda.
2. From the *Monthly Report Bot* folder, run:

   ```
   python -m gc_manager.rollback --yes
   ```

   This saves a copy of the database in `backups/` and then removes only the "version 3" marker. Older code otherwise refuses the database with "requires a newer application version". The added columns and tables stay, and older code ignores them.
3. Check out the older code and start NeraVeda.

Tested on 26 Nov 2026 with a copy of the live database:
- The older code opened it with all 35 claims and the review queue.
- The current code reopened it afterwards and restored the marker, with nothing lost.

## Checks (Phase 6, 26 Nov 2026)
- **Tests:** all 431 Python tests (32 test files, every module) and all web tests pass.
- **Web against old window:** on a copy of the live database, the web numbers match the database and the old window's own counts (10 of 10):
  - claim IDs and open, total and closed counts
  - emails per claim and linked emails
  - emails to review
- **Archive:** the 315 archived `.msg` files are byte-for-byte unchanged since the Phase 1 backup (SHA-256).
- **Not checked automatically:** the screens themselves. Sophos blocks automated browsers on this PC, so the user checks them visually.
