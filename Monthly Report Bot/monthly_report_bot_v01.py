from pathlib import Path
from playwright.sync_api import sync_playwright

MARIAPPS_URL = "https://apps.goodwoodship.com/Home/Landing"

PROJECT_FOLDER = Path(__file__).parent
BOT_PROFILE = PROJECT_FOLDER / "profiles" / "bot_chrome_profile"

with sync_playwright() as p:
    context = p.chromium.launch_persistent_context(
        user_data_dir=str(BOT_PROFILE),
        channel="chrome",
        headless=False,
        accept_downloads=True
    )

    if context.pages:
        page = context.pages[0]
    else:
        page = context.new_page()

    print("Opening MariApps...")
    page.goto(
        MARIAPPS_URL,
        wait_until="domcontentloaded",
        timeout=60000
    )

    print("Current URL:", page.url)
    print()
    print("FIRST SETUP ONLY:")
    print("Complete Microsoft sign-in manually.")
    print("Wait until the MariApps dashboard is fully visible.")
    print("Then return here and press Enter.")

    input("\nPress Enter only after MariApps dashboard is open...")

    context.close()

print("Monthly Report Bot profile saved.")