# Python Projects

Office automation tools for vessel reporting and inspection work.

| Module | What it is |
|---|---|
| [Fortnighly Bunker](Fortnighly%20Bunker/) | Outlook/Excel scripts to find, save and review fortnightly bunker reports |
| [Monthly Report Bot](Monthly%20Report%20Bot/README.md) | Automation suite for monthly vessel reports, GC manager, lube oil and voyage summaries |
| [Photo Assorter](Photo%20Assorter/README.md) | Inspection Intelligence: local photo sorting and classification for inspections |
| [Running Hour Sheet](Running%20Hour%20Sheet/README.md) | Machinery running-hours sheet generator, dashboard and MERN app |
| [Superintendent Inspection Report](Superintendent%20Inspection%20Report/Superintendent%20Inspection%20Report/README.md) | Next.js app for superintendent inspection reports |

Root scripts: `bot_ui.py`, `Ver2_download.py`.

## Setup
Virtualenvs, `node_modules`, ML models, browser profiles, `.env` files and vessel data are not committed. To set up a module:

- Python: `python -m venv .venv` then `pip install -r requirements.txt`
- Node: `npm install` (mern) or `pnpm install` (Next.js app)
- Copy `.env.example` to `.env` / `.env.local` and fill in the values
- Photo Assorter models: run `setup_fast_model.py`
- 