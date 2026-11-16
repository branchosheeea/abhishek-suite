"""Exercise desktop review state without a live model or user database."""
import tempfile
import tkinter as tk
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

from app import InspectionApp
from inspection_intelligence.models import ClassificationResult


class WorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = tk.Tk()
        self.root.withdraw()
        with patch('app.get_data_directory', return_value=Path(self.temp.name)):
            self.app = InspectionApp(self.root)
        self.app.results = [
            ClassificationResult('deck.jpg', 'missing.jpg', 'Vessel', '2026-11-10',
                                 'Main Deck', .92, 'Deck fittings', 120, 'Processed', 'test', 'v1', id=1),
            ClassificationResult('broken.png', 'missing.png', 'Vessel', '2026-11-10',
                                 None, None, 'Image failed', 10, 'Failed', 'test', 'v1', id=2),
        ]
        self.app._populate_results()

    def tearDown(self):
        self.root.destroy()
        for handler in list(self.app.logger.handlers):
            if getattr(handler, 'baseFilename', '') == str((Path(self.temp.name) / 'inspection_intelligence.log').resolve()):
                handler.close()
                self.app.logger.removeHandler(handler)
        self.temp.cleanup()

    def test_filters_clear_stale_details_and_allow_failed_corrections(self):
        self.app.filter_var.set('Failed')
        self.assertEqual(self.app.tree.get_children(), ('2',))
        self.assertEqual(str(self.app.approve_button['state']), 'disabled')
        self.assertEqual(str(self.app.change_button['state']), 'normal')
        self.app.search_var.set('no match')
        self.assertEqual(self.app.tree.get_children(), ())
        self.assertEqual(str(self.app.change_button['state']), 'disabled')
        self.assertEqual(self.app.classification_var.get(), '')

    def test_selection_survives_refresh_and_metrics_track_review(self):
        self.app.tree.selection_set('2')
        self.app._populate_results()
        self.assertEqual(self.app.tree.selection(), ('2',))
        self.app.results[0].review_status = 'Approved'
        self.app._show_summary()
        self.assertEqual(self.app.metric_values['pending'].get(), '1')
        self.app.filter_var.set('Reviewed')
        self.assertEqual(self.app.tree.get_children(), ('1',))

    def test_review_required_cannot_be_approved_from_the_workspace(self):
        self.app.results.append(
            ClassificationResult(
                'uncertain.jpg', 'missing-uncertain.jpg', 'Vessel', '2026-11-10',
                'Review Required', .29, 'Please review', 200, 'Processed', 'test', 'v1', id=3,
            )
        )
        self.app._populate_results()
        self.app.tree.selection_set('3')
        self.app._show_selected()

        self.assertEqual(str(self.app.approve_button['state']), 'disabled')
        self.assertEqual(str(self.app.change_button['state']), 'normal')

    def test_busy_form_is_locked_and_restored(self):
        self.app._set_busy(True)
        self.assertEqual(str(self.app.folder_entry['state']), 'disabled')
        self.app._set_busy(False)
        self.assertEqual(str(self.app.folder_entry['state']), 'normal')

    def test_workspace_scrolls_both_axes_and_accumulates_small_wheel_deltas(self):
        workspace = self.app.workspace
        self.root.update_idletasks()
        workspace._resize()
        canvas = workspace.canvas
        bounds = tuple(map(float, canvas['scrollregion'].split()))
        self.assertGreaterEqual(bounds[3], workspace.body.winfo_reqheight())
        canvas.yview_moveto(0)
        event = SimpleNamespace(widget=self.app.summary_label, state=0, delta=-60)
        workspace._wheel(event)
        self.assertEqual(canvas.yview()[0], 0)
        workspace._wheel(event)
        self.assertGreater(canvas.yview()[0], 0)
        canvas.xview_moveto(0)
        event.state = 1
        event.delta = -120
        workspace._wheel(event)
        self.assertGreater(canvas.xview()[0], 0)

    def test_workspace_does_not_steal_nested_text_scrolling(self):
        workspace = self.app.workspace
        self.root.update_idletasks()
        workspace.canvas.yview_moveto(0)
        text = self.app.reason_text
        text.configure(state='normal')
        text.insert('1.0', 'A line of reasoning\n' * 100)
        self.root.update_idletasks()
        event = SimpleNamespace(widget=text, state=0, delta=-120)
        workspace._wheel(event)
        self.assertEqual(workspace.canvas.yview()[0], 0)

    def test_wheel_binding_runs_before_native_widget_handlers(self):
        workspace = self.app.workspace
        for widget in (self.app.tree, self.app.reason_text, self.app.vessel_entry,
                       self.app.classification_box, workspace.canvas):
            self.assertEqual(widget.bindtags()[0], workspace._wheel_tag)
        self.root.update_idletasks()
        workspace.canvas.yview_moveto(0)
        # Exercise the actual Tk binding, not just the Python handler.
        workspace.canvas.event_generate('<MouseWheel>', delta=-120, rootx=-1, rooty=-1)
        self.assertGreater(workspace.canvas.yview()[0], 0)

    def test_wheel_over_focused_entry_uses_hovered_workspace(self):
        workspace = self.app.workspace
        self.root.update_idletasks()
        workspace.canvas.yview_moveto(0)
        event = SimpleNamespace(widget=self.app.classification_box, state=0,
                                delta=-120, x_root=10, y_root=10)
        with patch.object(workspace, 'winfo_containing', return_value=self.app.summary_label):
            workspace._wheel(event)
        self.assertGreater(workspace.canvas.yview()[0], 0)
