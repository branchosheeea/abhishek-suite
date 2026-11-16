from playwright.sync_api import sync_playwright

with sync_playwright() as p:

    browser = p.chromium.launch(
        channel="msedge",
        headless=False
    )

    page = browser.new_page()

    page.goto(
        "https://apps.goodwoodship.com/Home/Landing",
        wait_until="domcontentloaded"
    )

    print("MariApps opened")

    page.get_by_role(
        "link",
        name="SIGN IN Login with your Microsoft account",
        exact=True
    ).click()

    print("Microsoft Sign In clicked")

    input("Press Enter to close browser...")

    browser.close()