"""Read-only browser acceptance checks for the local operational dashboard."""
from pathlib import Path
import hashlib
import json
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent
data = root / 'dashboard_data.json'
before = hashlib.sha256(data.read_bytes()).hexdigest()
with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    page = browser.new_page(viewport={'width':1440,'height':1100}, device_scale_factor=1)
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://127.0.0.1:8765/', wait_until='networkidle')
    page.wait_for_selector('.metric-action')
    assert page.locator('.metric-action').count() == 4
    assert 'Year-to-date hours' not in page.locator('#metrics').inner_text()
    assert 'Monthly running hours' not in page.locator('#metrics').inner_text()
    october = page.locator('#metrics').inner_text()
    page.select_option('#month', '8')
    page.locator('[data-filter="exceptions"]').click()
    assert 'SPERRE Service Air Compressor' in page.locator('#reviews').inner_text()
    assert '+745 RH' in page.locator('#reviews').inner_text()
    assert page.locator('#reviews .review').count() == 1
    page.locator('#reviews [data-edit]').click()
    assert '716' in page.locator('#sourceDetail').inner_text()
    assert page.locator('#meterForm button[type=submit]').is_disabled()
    page.locator('#closeEditor').click()
    page.locator('#pmsRef').fill('PMS-TEST-001')
    with page.expect_popup() as report_popup:
        page.locator('#pmsRecord').click()
    report = report_popup.value
    report.wait_for_load_state()
    assert 'MONTH-END PMS ATTACHMENT' in report.locator('body').inner_text()
    assert 'PMS-TEST-001' in report.locator('body').inner_text()
    assert report.locator('tbody tr').count() == 35
    assert report.locator('text=716').count() >= 1
    report.close()
    page.locator('#pmsRef').fill('')
    page.locator('[data-review-filter="idle"]').click()
    assert page.locator('#reviews .review').count() == 4
    if page.locator('[data-trend]').count():
        chosen = page.locator('[data-trend]').first.get_attribute('data-trend')
        page.locator('[data-trend]').first.click()
        assert page.locator('#trendMachine').input_value() == chosen
    page.locator('[data-review-filter="all"]').click()
    page.evaluate('window.scrollTo(0,0)')
    page.screenshot(path=str(root/'dashboard_review_desktop.png'), full_page=True)
    page.set_viewport_size({'width':390,'height':844})
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    page.screenshot(path=str(root/'dashboard_review_mobile.png'), full_page=True)
    page.set_viewport_size({'width':1440,'height':1100})
    page.locator('#demo').click()
    page.wait_for_selector('#demoBanner:visible')
    page.locator('#demo').click()
    page.wait_for_selector('#demoBanner', state='hidden')
    page.select_option('#year','2025')
    page.select_option('#month','11')
    assert page.locator('.metric-action').count() == 4
    assert not errors, errors
    browser.close()
assert hashlib.sha256(data.read_bytes()).hexdigest() == before
print(json.dumps({'browser':'Edge','checks':'passed','data_unchanged':True,'october_cards':october},indent=2))
