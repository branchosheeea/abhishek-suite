from pathlib import Path
from playwright.sync_api import sync_playwright

PROFILE = Path(__file__).parent / "profiles" / "bot_profile"
MARIAPPS_URL = "https://apps.goodwoodship.com/Home/Landing"

with sync_playwright() as p:

    context = p.chromium.launch_persistent_context(
        user_data_dir=str(PROFILE),
        channel="msedge",
        headless=False,
        accept_downloads=True
    )

    try:
        landing_page = (
            context.pages[0]
            if context.pages
            else context.new_page()
        )

        print("Opening MariApps...")

        landing_page.goto(
            MARIAPPS_URL,
            wait_until="domcontentloaded",
            timeout=60000
        )

        print("Waiting for Microsoft Sign In...")

        sign_in = landing_page.locator("#winuseritem")

        sign_in.wait_for(
            state="visible",
            timeout=30000
        )

        print("Clicking Microsoft Sign In...")
        sign_in.click()

        print("Waiting for PAL dashboard...")

        landing_page.locator("#mainmenu-btn").wait_for(
            state="visible",
            timeout=60000
        )

        print("Opening Main Menu...")
        landing_page.locator("#mainmenu-btn").click()
        landing_page.wait_for_timeout(1500)

        print("Opening Maintenance...")

        landing_page.locator(
            "#main-menu-wrappper"
        ).get_by_text(
            "Maintenance",
            exact=True
        ).first.click()

        landing_page.wait_for_timeout(1500)

        print("Opening Equipment...")

        landing_page.locator(
            "#main-menu-wrappper"
        ).get_by_text(
            "Equipment",
            exact=True
        ).first.click()

        landing_page.wait_for_timeout(1500)

        print("Opening General...")

        pages_before = list(context.pages)

        landing_page.get_by_text(
            "General",
            exact=True
        ).first.click()

        equipment_page = None

        # Wait for the Equipment Details tab.
        for _ in range(30):
            landing_page.wait_for_timeout(1000)

            for candidate in context.pages:
                if candidate not in pages_before:
                    equipment_page = candidate
                    break

            if equipment_page is not None:
                break

        # Reuse an existing Equipment Details tab if PAL did not create a new one.
        if equipment_page is None:
            for candidate in context.pages:
                if "EquipmentGeneral" in candidate.url:
                    equipment_page = candidate
                    break

        if equipment_page is None:
            raise RuntimeError(
                "Equipment Details tab was not found."
            )

        equipment_page.bring_to_front()

        equipment_page.wait_for_load_state(
            "domcontentloaded",
            timeout=60000
        )

        print("Equipment Details opened:")
        print(equipment_page.url)

        print("Locating vessel selector...")

        vessel_box = equipment_page.locator(
            'input[aria-controls="vesselSearchBox_listbox"]'
        ).filter(visible=True).first

        if vessel_box.count() == 0:
            vessel_box = equipment_page.locator(
                ".header-vessel input.k-input.search-wrapper"
            ).filter(visible=True).first

        vessel_box.wait_for(
            state="visible",
            timeout=30000
        )

        print("Opening vessel selector...")
        vessel_box.click()

        equipment_page.wait_for_timeout(1000)

        # Reacquire because PAL may rerender the vessel control.
        vessel_box = equipment_page.locator(
            'input[aria-controls="vesselSearchBox_listbox"]'
        ).filter(visible=True).first

        if vessel_box.count() == 0:
            vessel_box = equipment_page.locator(
                ".header-vessel input.k-input.search-wrapper"
            ).filter(visible=True).first

        vessel_box.wait_for(
            state="visible",
            timeout=30000
        )

        print("Typing DHT LEOPARD...")

        vessel_box.click()
        vessel_box.press("Control+A")
        vessel_box.press("Backspace")

        vessel_box.press_sequentially(
            "DHT LEOPARD",
            delay=120
        )

        equipment_page.wait_for_timeout(3000)

        print("Clicking DHT LEOPARD result...")

        leopard_result = equipment_page.locator(
            "#vesselSearchBox_listbox"
        ).get_by_text(
            "DHT LEOPARD",
            exact=True
        ).first

        leopard_result.wait_for(
            state="visible",
            timeout=30000
        )

        leopard_result.click()

        print("Waiting for DHT LEOPARD equipment tree...")
        equipment_page.wait_for_timeout(8000)

        print("DHT LEOPARD selected successfully.")

        input(
            "\nConfirm DHT LEOPARD is displayed, "
            "then press Enter to close Edge..."
        )

    except Exception as error:
        print("\nBOT STOPPED:")
        print(error)

        input(
            "\nEdge remains open for inspection. "
            "Press Enter to close..."
        )

    finally:
        context.close()