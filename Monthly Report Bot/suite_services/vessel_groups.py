"""Suite-wide vessel groups: user-defined sets of ships that any module can compare across.

Groups live in the shared Suite database (core schema v2). A vessel may belong to several groups.
Deleting a group archives it, so its change history is kept.
"""
from __future__ import annotations
from datetime import datetime, timezone
import json

from .actor import current_actor
from .database import connection, initialize

MINIMUM_VESSELS = 2


def _now():
    return datetime.now(timezone.utc).isoformat()


def _history(db, group_id, action, detail):
    db.execute("INSERT INTO vessel_group_history(group_id,action,detail,actor,created_at) VALUES(?,?,?,?,?)",
               (group_id, action, json.dumps(detail), current_actor(), _now()))


def _members(db, group_id):
    return [row[0] for row in db.execute(
        """SELECT v.name FROM vessel_group_members m JOIN vessels v ON v.id=m.vessel_id
           WHERE m.group_id=? ORDER BY v.name""", (group_id,))]


def groups(root):
    """Current (not archived) groups, by name, each with its member vessel names."""
    initialize(root)
    with connection(root) as db:
        rows = [dict(row) for row in db.execute(
            "SELECT * FROM vessel_groups WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE")]
        for row in rows:
            row["vessels"] = _members(db, row["id"])
    return rows


def save_group(root, name, vessels, description=None, group_id=None):
    """Create a group, or rename/re-describe an existing one and replace its members. Returns the group id."""
    name = " ".join((name or "").split())
    if not name:
        raise ValueError("Give the group a name.")
    vessels = sorted(set(vessels or ()))
    if len(vessels) < MINIMUM_VESSELS:
        raise ValueError(f"A group needs at least {MINIMUM_VESSELS} vessels to compare.")
    description = (description or "").strip() or None
    initialize(root)
    with connection(root) as db, db:
        ids = {}
        for vessel in vessels:
            row = db.execute("SELECT vessel_id FROM vessel_aliases WHERE alias=?", (vessel,)).fetchone()
            if row is None:
                raise ValueError(f"{vessel} is not in the Suite vessel master.")
            ids[vessel] = row[0]
        clash = db.execute("SELECT id FROM vessel_groups WHERE name=? COLLATE NOCASE AND archived_at IS NULL AND id IS NOT ?",
                           (name, group_id)).fetchone()
        if clash:
            raise ValueError(f"A group called '{name}' already exists.")
        stamp = _now()
        if group_id is None:
            group_id = db.execute(
                "INSERT INTO vessel_groups(name,description,created_by,created_at,updated_at) VALUES(?,?,?,?,?)",
                (name, description, current_actor(), stamp, stamp)).lastrowid
            old = None
        else:
            existing = db.execute("SELECT name,description FROM vessel_groups WHERE id=? AND archived_at IS NULL",
                                  (group_id,)).fetchone()
            if existing is None:
                raise ValueError("That group no longer exists.")
            old = dict(existing, vessels=_members(db, group_id))
            db.execute("UPDATE vessel_groups SET name=?,description=?,updated_at=? WHERE id=?",
                       (name, description, stamp, group_id))
            db.execute("DELETE FROM vessel_group_members WHERE group_id=?", (group_id,))
        for vessel_id in ids.values():
            db.execute("INSERT INTO vessel_group_members(group_id,vessel_id,added_at) VALUES(?,?,?)",
                       (group_id, vessel_id, stamp))
        new = dict(name=name, description=description, vessels=vessels)
        _history(db, group_id, "created" if old is None else "updated", dict(old=old, new=new))
    return group_id


def archive_group(root, group_id):
    initialize(root)
    with connection(root) as db, db:
        row = db.execute("SELECT name FROM vessel_groups WHERE id=? AND archived_at IS NULL", (group_id,)).fetchone()
        if row is None:
            raise ValueError("That group no longer exists.")
        db.execute("UPDATE vessel_groups SET archived_at=?,updated_at=? WHERE id=?", (_now(), _now(), group_id))
        _history(db, group_id, "archived", dict(name=row["name"], vessels=_members(db, group_id)))


def group_history(root, group_id):
    initialize(root)
    with connection(root) as db:
        rows = [dict(row) for row in db.execute(
            "SELECT action,detail,actor,created_at FROM vessel_group_history WHERE group_id=? ORDER BY id", (group_id,))]
    for row in rows:
        row["detail"] = json.loads(row["detail"])
    return rows
