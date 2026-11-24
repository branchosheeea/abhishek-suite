import tkinter as tk
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import customtkinter as ctk

from lube_oil.ui import ReviewApp
from vessel_report.scroll_input import ScrollRouter


class ScrollInputTests(unittest.TestCase):
    def test_router_closes_diagnostics_without_a_heartbeat_callback(self):
        root = tk.Tk()
        router = ScrollRouter(root)
        try:
            self.assertFalse(hasattr(router, "timer"))
            root.destroy()
            self.assertTrue(router._closed)
            self.assertEqual(router.log.handlers, [])
            router.close(SimpleNamespace(widget=root))
            self.assertEqual(router.log.handlers, [])
        finally:
            if not router._closed:
                root.destroy()

    def test_review_analysis_follows_vessel_selection_and_scrolls_with_wheel(self):
        def report(
            report_id, vessel, month, engine_count=1, consumption=100,
            confirmed=False,
        ):
            engines = [{"engine": "ME", "hours": 100, "rate": 20}]
            engines.extend(
                {"engine": f"AE{index}", "hours": 100, "rate": 10}
                for index in range(1, engine_count)
            )
            return {
                "id": report_id,
                "vessel": vessel,
                "month": month,
                "report_version": 1,
                "is_active": confirmed,
                "confirmed_at": "2025-12-01T00:00:00" if confirmed else None,
                "filename": f"{vessel}-{month}.xlsx",
                "validation_status": "PASS",
                "data": {
                    "vessel": vessel,
                    "inventory": [{
                        "category": "SYSTEM OIL M/E",
                        "grade": "OIL A",
                        "unit": "L",
                        "operating": consumption,
                        "change_loss": 0,
                        "all_in": consumption,
                    }],
                    "engines": engines,
                    "issues": [],
                    "evidence": {},
                },
            }

        reports = [
            report(1, "DHT COLT", "2026-10", engine_count=15),
            report(2, "DHT LEOPARD", "2025-10", consumption=80, confirmed=True),
            report(3, "DHT COLT", "2026-09"),
            report(4, "DHT LEOPARD", "2025-12", consumption=150),
            report(5, "DHT LEOPARD", "2025-09", consumption=100, confirmed=True),
            report(6, "DHT LEOPARD", "2025-11", consumption=120, confirmed=True),
        ]

        class FakeRepository:
            def __init__(self, _root=None):
                pass

            def reprocess_stale_reports(self):
                return 0

            def retry_failed_imports(self):
                return []

            def activate_imported(self):
                return 0

            def reports(self):
                return reports

        with patch("lube_oil.ui.Repository", FakeRepository):
            app = ReviewApp()
        try:
            app.geometry("1280x760")
            app.update()
            app.show("Monthly Analysis")
            app.vessel.set("DHT LEOPARD")
            app.change_vessel("DHT LEOPARD")
            app.update()
            self.assertEqual(
                [vessel["vessel"] for vessel in app.monthly_analysis["vessels"]],
                ["DHT LEOPARD"],
            )
            self.assertEqual(app.analysis_month, "2025-12")
            self.assertEqual(app.monthly_analysis["vessels"][0]["state"], "provisional")
            self.assertEqual(
                app.monthly_analysis["vessels"][0]["report"]["month"],
                "2025-12",
            )
            overview_labels = []

            def collect_overview_labels(widget):
                if isinstance(widget, ctk.CTkLabel):
                    overview_labels.append(widget.cget("text"))
                for child in widget.winfo_children():
                    collect_overview_labels(child)

            collect_overview_labels(app.body)
            self.assertIn("Technical review brief", overview_labels)
            self.assertTrue(any(
                "PRIMARY BULK GRADES" in text
                for text in overview_labels
            ))
            self.assertTrue(any(
                "NOT USABLE" in text
                for text in overview_labels
            ))
            overview_canvases = []

            def collect_overview_canvases(widget):
                if isinstance(widget, tk.Canvas):
                    overview_canvases.append(widget)
                for child in widget.winfo_children():
                    collect_overview_canvases(child)

            collect_overview_canvases(app.body)
            chart_text = [
                canvas.itemcget(item, "text")
                for canvas in overview_canvases
                for item in canvas.find_all()
                if canvas.type(item) == "text"
            ]
            self.assertTrue(any(
                "150.0 L  ·  avg 100.0 L  ·  3/3 months  ·  +50.0%" in text
                for text in chart_text
            ), chart_text)

            app.vessel.set("DHT COLT")
            app.change_vessel("DHT COLT")
            app.update()
            self.assertEqual(app.analysis_month, "2026-10")
            self.assertEqual(
                [vessel["vessel"] for vessel in app.monthly_analysis["vessels"]],
                ["DHT COLT"],
            )
            app.show("Consumption")
            app.update()
            page_labels = []

            def collect_labels(widget):
                if isinstance(widget, ctk.CTkLabel):
                    page_labels.append(widget.cget("text"))
                for child in widget.winfo_children():
                    collect_labels(child)

            collect_labels(app.body)
            self.assertIn("Bulk oil consumption by grade", page_labels)
            self.assertIn("Consumption trend", page_labels)
            option_values = []

            def collect_options(widget):
                if isinstance(widget, ctk.CTkOptionMenu):
                    option_values.extend(widget.cget("values"))
                for child in widget.winfo_children():
                    collect_options(child)

            collect_options(app.body)
            self.assertIn("System oil · ME · OIL A", option_values)
            self.assertTrue(
                any("preliminary reference · verify" in text.casefold() for text in page_labels),
                page_labels,
            )
            self.assertTrue(
                any("comparable months" in text.casefold() for text in page_labels),
                page_labels,
            )
            canvas_widgets = []

            def collect_canvases(widget):
                if isinstance(widget, tk.Canvas):
                    canvas_widgets.append(widget)
                for child in widget.winfo_children():
                    collect_canvases(child)

            collect_canvases(app.body)
            self.assertTrue(canvas_widgets)
            self.assertGreaterEqual(
                sum(
                    canvas.type(item) == "rectangle"
                    for canvas in canvas_widgets
                    for item in canvas.find_all()
                ),
                2,
            )
            self.assertTrue(any("l/day" in text.casefold() for text in page_labels))
            canvas = app.body._parent_canvas
            self.assertLess(canvas.yview()[1], 1)
            canvas.yview_moveto(0)
            app.update()
            first_label = next(
                widget for widget in app.body.winfo_children()
                if isinstance(widget, ctk.CTkLabel)
            )
            before = canvas.yview()[0]
            first_label.event_generate("<MouseWheel>", delta=-120)
            app.update()
            self.assertGreater(canvas.yview()[0], before)
            self.assertIn(app.body, app.scroll_router.targets)
        finally:
            if getattr(app, "timer", None):
                app.after_cancel(app.timer)
            app.destroy()

    def test_touchpad_rows_canvas_rebuild_and_picker(self):
        root = ctk.CTk()
        root.geometry("420x320")
        router = ScrollRouter(root)
        frame = ctk.CTkScrollableFrame(root, height=230)
        frame.pack(fill="both", expand=True)

        def populate(parent):
            labels = []
            for n in range(60):
                label = ctk.CTkLabel(parent, text=f"Row {n}")
                label.pack()
                labels.append(label)
            router.attach(parent)
            return labels

        labels = populate(frame)
        root.update()
        try:
            self.assertGreater(frame._parent_canvas.winfo_height(), 100)
            self.assertLess(frame._parent_canvas.yview()[1], 1)
            for target in (frame._parent_canvas, labels[0], labels[0]._label):
                canvas = frame._parent_canvas
                canvas.yview_moveto(.5)
                before = canvas.yview()[0]
                # Low 16 bits: negative Y means down; horizontal must be ignored.
                target.event_generate("<TouchpadScroll>", delta=(7 << 16) | 0xffec)
                self.assertGreater(canvas.yview()[0], before)
                target.event_generate("<TouchpadScroll>", delta=20)
                self.assertAlmostEqual(canvas.yview()[0], before, places=3)
                target.event_generate("<TouchpadScroll>", delta=12 << 16)
                self.assertAlmostEqual(canvas.yview()[0], before, places=3)
                target.event_generate("<MouseWheel>", delta=-120)
                self.assertGreater(canvas.yview()[0], before)

            for child in frame.winfo_children():
                child.destroy()
            labels = populate(frame)
            root.update()
            frame._parent_canvas.yview_moveto(.5)
            before = frame._parent_canvas.yview()[0]
            labels[0]._label.event_generate("<TouchpadScroll>", delta=0xffff)
            self.assertGreater(frame._parent_canvas.yview()[0], before)

            picker = ctk.CTkToplevel(root)
            picker.geometry("300x300")
            vessels = ctk.CTkScrollableFrame(picker)
            vessels.pack(fill="both", expand=True)
            vessel_labels = populate(vessels)
            root.update()
            before_reports = frame._parent_canvas.yview()
            vessel_labels[0]._label.event_generate("<TouchpadScroll>", delta=0xffec)
            self.assertGreater(vessels._parent_canvas.yview()[0], 0)
            self.assertEqual(frame._parent_canvas.yview(), before_reports)
            picker.destroy()
            # A gesture delivered to the focused top-level must still scroll
            # the hovered list; it has no list-specific bindtag.
            canvas = frame._parent_canvas
            canvas.yview_moveto(.5)
            before = canvas.yview()[0]
            with patch.object(router, "hovered_frame", return_value=frame):
                root.event_generate("<TouchpadScroll>", delta=0xffec)
            self.assertGreater(canvas.yview()[0], before)
            before = canvas.yview()
            with patch.object(router, "hovered_frame", return_value=None):
                root.event_generate("<TouchpadScroll>", delta=0xffec)
            self.assertEqual(canvas.yview(), before)
        finally:
            root.destroy()


if __name__ == "__main__":
    unittest.main()
