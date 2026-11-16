"""One scroll binding per list, including Tk 9 precision touchpad events."""
import tkinter as tk
import weakref
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import sys


class ScrollRouter:
    def __init__(self, root):
        self.root = root
        self.targets = weakref.WeakKeyDictionary()
        self.log = logging.getLogger(f"scroll_input.{id(self)}")
        self.log.setLevel(logging.INFO)
        self.log.propagate = False
        self.log_path = Path(__file__).with_name("scroll_diagnostics.log")
        handler = RotatingFileHandler(self.log_path, maxBytes=262144, backupCount=1)
        handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
        self.log.addHandler(handler)
        self._closed = False
        self.log.info("START python=%s tk=%s source=%s", sys.executable,
                      root.tk.call("package", "provide", "Tk"), __file__)
        # Some input paths deliver gestures to the focused window instead of
        # the child under the pointer. Such events don't visit the list's tag.
        for sequence in ("<MouseWheel>", "<Button-4>", "<Button-5>", "<TouchpadScroll>"):
            try:
                root.bind_all(sequence, lambda event, s=sequence: self.fallback(event, s), add="+")
            except tk.TclError:
                self.log.info("UNSUPPORTED %s", sequence)
        root.bind("<Destroy>", self.close, add="+")

    def hovered_frame(self):
        x, y = self.root.winfo_pointerxy()
        child = self.root.winfo_containing(x, y)
        while child is not None:
            for frame in list(self.targets):
                if child is frame or child is frame._parent_canvas:
                    return frame
            child = getattr(child, "master", None)
        return None

    def fallback(self, event, sequence):
        frame = self.hovered_frame()
        self.log.info("FALLBACK event=%s widget=%s delta=%s target=%s",
                      sequence, event.widget, event.delta, frame)
        if frame is not None:
            if sequence == "<TouchpadScroll>":
                return self.touchpad(frame, event)
            return self.wheel(frame, event)

    def close(self, event):
        if event.widget is not self.root or self._closed:
            return
        self._closed = True
        for handler in self.log.handlers[:]:
            handler.close()
            self.log.removeHandler(handler)

    def attach(self, widget):
        frame = widget
        while frame is not None and not hasattr(frame, "_parent_canvas"):
            frame = getattr(frame, "master", None)
        if frame is None:
            return
        if frame not in self.targets:
            tag = f"ReportScroll:{frame}"
            self.targets[frame] = tag
            for sequence in ("<MouseWheel>", "<Button-4>", "<Button-5>"):
                self.root.bind_class(
                    tag, sequence, lambda event, f=frame: self.wheel(f, event))
            try:
                self.root.bind_class(
                    tag, "<TouchpadScroll>",
                    lambda event, f=frame: self.touchpad(f, event))
            except tk.TclError:
                pass  # Tk 8.6 reports touchpad gestures as MouseWheel.
            frame.bind("<Destroy>", lambda event, f=frame: self.detach(f, event), add="+")
        tag = self.targets[frame]

        def visit(child):
            tags = child.bindtags()
            if tag not in tags:
                child.bindtags((tag, *tags))
            for descendant in child.winfo_children():
                visit(descendant)

        visit(widget)
        canvas = frame._parent_canvas
        tags = canvas.bindtags()
        if tag not in tags:
            canvas.bindtags((tag, *tags))

    def detach(self, frame, event):
        if event.widget is not frame:
            return
        tag = self.targets.pop(frame, None)
        if tag:
            for sequence in ("<MouseWheel>", "<Button-4>", "<Button-5>", "<TouchpadScroll>"):
                try:
                    self.root.unbind_class(tag, sequence)
                except tk.TclError:
                    pass

    def wheel(self, frame, event):
        before = frame._parent_canvas.yview()
        if event.num == 4:
            steps = -3
        elif event.num == 5:
            steps = 3
        elif event.delta:
            steps = -int(event.delta / 40) or (-1 if event.delta > 0 else 1)
        else:
            return "break"
        frame._parent_canvas.yview_scroll(steps, "units")
        self.log.info("WHEEL widget=%s delta=%s target=%s before=%s after=%s",
                      event.widget, event.delta, frame, before, frame._parent_canvas.yview())
        return "break"

    def touchpad(self, frame, event):
        # Tk packs signed X/Y pixel deltas into the high/low 16 bits.
        # Use Tk's own decoder and scroll in pixels, not wheel notches.
        _, dy = frame.tk.call("tk::PreciseScrollDeltas", event.delta)
        canvas = frame._parent_canvas
        before = canvas.yview()
        bounds = canvas.bbox("all")
        if dy and bounds and bounds[3] > bounds[1]:
            start = canvas.yview()[0]
            canvas.yview_moveto(start - int(dy) / (bounds[3] - bounds[1]))
        self.log.info("TOUCHPAD widget=%s raw=%s dy=%s target=%s bounds=%s before=%s after=%s",
                      event.widget, event.delta, dy, frame, bounds, before, canvas.yview())
        return "break"
