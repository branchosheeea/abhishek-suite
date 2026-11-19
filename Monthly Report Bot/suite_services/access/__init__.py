"""NeraVeda sign-in and module access rights.

- Identity: Microsoft work account (Entra ID), signed in by the launcher only (signin.py).
- Rights: central list in MongoDB Atlas `neraveda_access`, read-only on every PC, written only from admin PCs
  (store.py); module on/off + admin flag in v1 (entitlements.py).
- Session: DPAPI-protected session.bin read by the launcher and by each workspace's require_module() (session.py,
  guard.py); web workspaces get short-lived signed tickets (tickets.py).
- Local mode: until sign-in is set up (and while policy.json does not require it) the suite behaves as before:
  the Windows user, all modules.

Submodules are imported lazily so workspaces only load what they use.
"""
