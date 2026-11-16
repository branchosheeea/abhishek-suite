import queue
import logging
import os
import sys
import threading
import tkinter as tk
from time import monotonic
from datetime import datetime
from pathlib import Path
from tkinter import filedialog, messagebox

from PIL import Image, ImageTk, ImageOps

from inspection_intelligence.workspace import build_workspace

from inspection_intelligence.configuration import get_data_directory, get_config_directory, load_configuration
from inspection_intelligence.services.ai.fast_local_provider import FastLocalProvider
from inspection_intelligence.exports.excel_export import export_results
from inspection_intelligence.persistence.database import Database
from inspection_intelligence.services.ai.ollama_provider import OllamaProvider
from inspection_intelligence.services.classification_engine import (
    ClassificationEngine,
    summarize,
)
from inspection_intelligence.services.storage.local_storage import discover_photos


class InspectionApp:
    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("Inspection Intelligence")
        self.root.geometry("1100x820")
        self.configuration = load_configuration()
        self.data_directory = get_data_directory()
        self.database = Database(
            self.data_directory / "inspection_intelligence.sqlite3"
        )
        self.log_path = self.data_directory / "inspection_intelligence.log"
        self.logger = logging.getLogger("inspection_intelligence.desktop")
        self.logger.setLevel(logging.INFO)
        self.logger.propagate = False
        if not any(
            isinstance(handler, logging.FileHandler)
            and Path(handler.baseFilename) == self.log_path.resolve()
            for handler in self.logger.handlers
        ):
            file_handler = logging.FileHandler(self.log_path, encoding="utf-8")
            file_handler.setFormatter(
                logging.Formatter("%(asctime)s %(levelname)s %(message)s")
            )
            self.logger.addHandler(file_handler)
        self.provider = OllamaProvider(
            base_url=self.configuration.ollama_url,
            model_name=self.configuration.model_name,
            prompt=self.configuration.prompt,
            taxonomy=self.configuration.taxonomy,
            timeout_seconds=self.configuration.request_timeout_seconds,
            max_image_dimension=self.configuration.max_image_dimension,
            max_output_tokens=self.configuration.max_output_tokens,
            context_length=self.configuration.context_length,
        )
        self.engine = ClassificationEngine(
            self.provider, self.database, self.configuration.prompt_version,
            reuse_results=self.configuration.reuse_results,
        )
        self.results = []
        self.message_queue: queue.Queue[tuple] = queue.Queue()
        self.thumbnail = None
        self.cancel_event = threading.Event()
        self.analysis_started = None

        self._build_ui()
        self.root.after(100, self._poll_messages)

    def _build_ui(self) -> None:
        build_workspace(self)

    def _select_folder(self) -> None:
        folder = filedialog.askdirectory(title="Select inspection photo folder")
        if folder:
            self.folder_var.set(folder)

    def _start_analysis(self) -> None:
        folder_text = self.folder_var.get().strip()
        try:
            if not folder_text:
                raise ValueError("Select an inspection photo folder.")
            folder = Path(folder_text)
            photos = discover_photos(folder)
            vessel = self.vessel_entry.get().strip()
            inspection_date = self.date_entry.get().strip()
            if not vessel:
                raise ValueError("Enter the vessel name.")
            try:
                datetime.strptime(inspection_date, "%Y-%m-%d")
            except ValueError:
                raise ValueError("Enter a valid inspection date in YYYY-MM-DD format.") from None
            if not photos:
                raise ValueError("No supported .jpg, .jpeg, or .png photographs were found.")
        except (OSError, ValueError) as error:
            self.logger.warning("Cannot start analysis: %s", error)
            messagebox.showerror("Cannot analyse inspection", str(error))
            return

        if self.mode_var.get() == "Fast local sorting":
            if not isinstance(self.engine.provider, FastLocalProvider):
                self.engine.provider = FastLocalProvider(
                    get_config_directory().parent / "models" / "clip-vit-base-patch32",
                    self.configuration.taxonomy)
        else:
            self.engine.provider = self.provider
        self.tree.heading("confidence", text="Similarity" if isinstance(self.engine.provider, FastLocalProvider) else "Confidence")

        self._log(
            f"Starting inspection analysis: {len(photos)} photos; vessel={vessel}; "
            f"date={inspection_date}; folder={folder}; mode={self.mode_var.get()}; "
            f"python={sys.executable}"
        )
        self.results = []
        self.cancel_event.clear()
        self.analysis_started = monotonic()
        self.search_var.set("")
        self.filter_var.set("All photos")
        self._show_summary()
        self.empty_label.configure(text="Analysing your photographs...\n\nResults appear as each photo finishes. You can review them immediately.")
        self.tree.delete(*self.tree.get_children())
        self._clear_details()
        self.analyse_button.configure(state="disabled")
        self.select_button.configure(state="disabled")
        self.export_button.configure(state="disabled")
        self.progress_bar.configure(maximum=len(photos), value=0)
        self._set_busy(True)
        self.progress_bar.configure(mode="indeterminate")
        self.progress_bar.start(10)
        self.progress_label.configure(text="Preparing local model...")
        self.summary_label.configure(text=f"Found {len(photos)} supported photographs.")
        worker = threading.Thread(
            target=self._run_analysis,
            args=(photos, vessel, inspection_date),
            daemon=True,
        )
        worker.start()

    def _run_analysis(self, photos: list[Path], vessel: str, inspection_date: str) -> None:
        try:
            results = self.engine.classify_batch(
                photos,
                vessel,
                inspection_date,
                progress_callback=lambda current, total, name: self.message_queue.put(
                    ("progress", current, total, name)
                ),
                event_callback=self._log,
                result_callback=lambda result: self.message_queue.put(("result", result)),
                cancel_event=self.cancel_event,
            )
            self.message_queue.put(("complete", results))
        except Exception as error:
            self.logger.exception("Inspection analysis stopped unexpectedly.")
            self.message_queue.put(("error", str(error)))

    def _log(self, message: str) -> None:
        self.logger.info("%s", message)
        self.message_queue.put(("log", message))

    def _poll_messages(self) -> None:
        try:
            while True:
                message = self.message_queue.get_nowait()
                if message[0] == "progress":
                    _, current, total, filename = message
                    self.progress_bar.stop()
                    self.progress_bar.configure(mode="determinate", maximum=total, value=current)
                    elapsed = monotonic() - self.analysis_started if self.analysis_started else 0
                    remaining = elapsed / current * (total - current) if current else 0
                    prefix = "Stopping after current photo" if self.cancel_event.is_set() else "Processed"
                    self.progress_label.configure(text=f"{prefix}: {current} / {total} | "
                        f"{elapsed / current:.1f}s/photo | About {remaining / 60:.1f} min remaining")
                elif message[0] == "result":
                    self.results.append(message[1])
                    self._populate_results()
                    self._show_summary()
                    self.export_button.configure(state="normal")
                elif message[0] == "log":
                    self.log_text.configure(state="normal")
                    self.log_text.insert("end", f"{message[1]}\n")
                    self.log_text.see("end")
                    self.log_text.configure(state="disabled")
                elif message[0] == "complete":
                    self._complete_analysis(message[1])
                elif message[0] == "error":
                    self._analysis_error(message[1])
        except queue.Empty:
            pass
        self.root.after(100, self._poll_messages)

    def _complete_analysis(self, results) -> None:
        self.progress_bar.stop()
        self._set_busy(False)
        self.progress_bar.configure(mode="determinate", value=len(results))
        # Reviews may have been saved while the worker processed later photos.
        self.results = self.database.list_results([result.id for result in results])
        self._populate_results()
        self.analyse_button.configure(state="normal")
        self.select_button.configure(state="normal")
        self.export_button.configure(state="normal" if results else "disabled")
        state = "Stopped" if self.cancel_event.is_set() else "Complete"
        self.progress_label.configure(text=f"{state}: {len(results)} photographs")
        self._show_summary()
        failed = sum(result.status == "Failed" for result in results)
        self._log(
            f"Analysis finished: {len(results) - failed} processed, {failed} failed."
        )

    def _analysis_error(self, error: str) -> None:
        self.progress_bar.stop()
        self.analyse_button.configure(state="normal")
        self.select_button.configure(state="normal")
        self._set_busy(False)
        self.progress_bar.configure(mode="determinate", value=0)
        self.empty_label.configure(text="Analysis stopped\n\nCheck the Activity log, then try again.")
        self.progress_label.configure(text="Analysis stopped")
        self._log(f"Analysis stopped unexpectedly: {error}")
        messagebox.showerror("Analysis could not be completed", error)

    def _open_log_folder(self) -> None:
        try:
            os.startfile(self.log_path.parent)
        except OSError as error:
            self.logger.exception("Could not open the log folder.")
            messagebox.showerror("Could not open log folder", str(error))

    def _set_busy(self, busy: bool) -> None:
        for entry in (self.vessel_entry, self.date_entry, self.folder_entry):
            entry.configure(state="disabled" if busy else "normal")
        self.analyse_button.configure(text="Analysing..." if busy else "Analyse inspection")
        self.stop_button.configure(state="normal" if busy else "disabled")
        self.mode_box.configure(state="disabled" if busy else "readonly")

    def _stop_analysis(self) -> None:
        self.cancel_event.set()
        self.stop_button.configure(state="disabled")
        self.progress_label.configure(text="Stopping after the current photo finishes. Completed results are saved.")

    def _populate_results(self) -> None:
        selection = self.tree.selection()
        self.tree.delete(*self.tree.get_children())
        query = self.search_var.get().strip().casefold()
        mode = self.filter_var.get()
        visible = []
        for result in self.results:
            if query and query not in f"{result.filename} {result.ai_level1 or ''} {result.final_level1 or ''}".casefold():
                continue
            if mode == "Pending review" and result.review_status != "Pending":
                continue
            if mode == "Reviewed" and result.review_status == "Pending":
                continue
            if mode == "Failed" and result.status != "Failed":
                continue
            visible.append(result)
            self.tree.insert("", "end", iid=str(result.id), values=(
                result.filename, result.ai_level1 or "?",
                f"{result.ai_confidence:.0%}" if result.ai_confidence is not None else "?",
                result.processing_time_ms, result.status, result.review_status,
            ), tags=("failed" if result.status == "Failed" else "alternate" if len(visible) % 2 == 0 else "",))
        if visible:
            self.empty_label.place_forget()
            selected = selection[0] if selection and self.tree.exists(selection[0]) else str(visible[0].id)
            self.tree.selection_set(selected)
            self.tree.focus(selected)
            self.tree.see(selected)
            self._show_selected()
        else:
            self._clear_details()
            self.empty_label.configure(text=("No matching photographs\n\nTry another search or review filter." if self.results else
                "Your inspection starts here\n\nChoose a photo folder, then select Analyse inspection."))
            self.empty_label.place(relx=.5, rely=.5, anchor="center")

    def _show_summary(self) -> None:
        summary = summarize(self.results, self.configuration.taxonomy)
        for key in ("total", "processed", "failed"):
            self.metric_values[key].set(str(summary[key]))
        self.metric_values["pending"].set(str(sum(r.review_status == "Pending" for r in self.results)))
        accuracy = f"{summary['accuracy']:.1%}" if summary['accuracy'] is not None else "Awaiting reviewer classifications"
        self.summary_label.configure(text=(
            f"Reviewer agreement: {accuracy}   ?   Exact matches: {summary['exact_matches']}   ?   "
            f"Mismatches: {summary['mismatches']}   ?   AI review required: {summary['review_required']}   ?   "
            f"Average: {summary['average_processing_time_ms'] / 1000:.1f}s / photo"
        ))

    def _show_selected(self, _event=None) -> None:
        selected = self.tree.selection()
        if not selected:
            self._clear_details()
            return
        result = next((item for item in self.results if str(item.id) == selected[0]), None)
        if result is None:
            return
        self.detail_filename.configure(text=result.filename)
        self.final_label.configure(
            text=f"Final Classification: {result.final_level1 or '—'}"
        )
        self.reason_text.configure(state="normal")
        self.reason_text.delete("1.0", "end")
        self.reason_text.insert("1.0", result.ai_reason)
        self.reason_text.configure(state="disabled")
        self.classification_var.set(
            result.abhishek_level1 or result.ai_level1 or ""
        )
        self.approve_button.configure(
            state="normal"
            if result.status == "Processed"
            and result.ai_level1 != self.configuration.taxonomy.review_required
            else "disabled"
        )
        self.change_button.configure(state="normal")
        self.classification_box.configure(state="readonly")
        try:
            with Image.open(result.path) as source:
                image = ImageOps.exif_transpose(source).copy()
            image.thumbnail((340, 190), Image.Resampling.LANCZOS)
            self.thumbnail = ImageTk.PhotoImage(image)
            self.image_label.configure(image=self.thumbnail, text="")
        except OSError as error:
            self.thumbnail = None
            self.image_label.configure(text=f"Thumbnail unavailable: {error}", image="")

    def _clear_details(self) -> None:
        self.detail_filename.configure(text="")
        self.final_label.configure(text="Final Classification: —")
        self.reason_text.configure(state="normal")
        self.reason_text.delete("1.0", "end")
        self.reason_text.configure(state="disabled")
        self.classification_var.set("")
        self.classification_box.configure(state="disabled")
        self.approve_button.configure(state="disabled")
        self.change_button.configure(state="disabled")
        self.thumbnail = None
        self.image_label.configure(image="", text="Select a photograph to review")

    def _selected_result(self):
        selected = self.tree.selection()
        if not selected:
            messagebox.showinfo("Select a photograph", "Select a photograph to review.")
            return None
        return next((item for item in self.results if str(item.id) == selected[0]), None)

    def _approve(self) -> None:
        result = self._selected_result()
        if result is None:
            return
        try:
            self.database.approve(result.id, self.configuration.taxonomy)
            self._refresh_result(result.id)
        except ValueError as error:
            messagebox.showerror("Cannot approve classification", str(error))

    def _change_classification(self) -> None:
        result = self._selected_result()
        if result is None:
            return
        value = self.classification_var.get()
        try:
            self.database.set_abhishek_classification(
                result.id, value, self.configuration.taxonomy
            )
            self._refresh_result(result.id)
        except ValueError as error:
            messagebox.showerror("Cannot change classification", str(error))

    def _refresh_result(self, result_id: int) -> None:
        updated = self.database.list_results([result_id])[0]
        self.results = [updated if result.id == result_id else result for result in self.results]
        self._populate_results()
        self._show_summary()

    def _export(self) -> None:
        if not self.results:
            return
        output = filedialog.asksaveasfilename(
            title="Export inspection results",
            defaultextension=".xlsx",
            filetypes=[("Excel workbook", "*.xlsx")],
            initialfile="inspection-results.xlsx",
        )
        if not output:
            return
        try:
            export_results(self.results, Path(output))
        except (OSError, ValueError) as error:
            messagebox.showerror("Excel export failed", str(error))
            return
        messagebox.showinfo("Export complete", f"Results exported to:\n{output}")


def main() -> None:
    root = tk.Tk()
    InspectionApp(root)
    root.mainloop()


if __name__ == "__main__":
    main()
