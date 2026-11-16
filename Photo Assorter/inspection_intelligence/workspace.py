"""Desktop workspace layout and shared visual styles."""
import tkinter as tk
from datetime import date
from tkinter import ttk
from tkinter.scrolledtext import ScrolledText

BG = '#F2F5F8'
INK = '#172D42'
MUTED = '#617487'
TEAL = '#087F83'


class ScrollableWorkspace(ttk.Frame):
    """Keep the full workspace reachable without stealing nested widget scrolling."""

    def __init__(self, parent):
        super().__init__(parent)
        self.rowconfigure(0, weight=1)
        self.columnconfigure(0, weight=1)
        self.canvas = tk.Canvas(self, background=BG, highlightthickness=0,
                                yscrollincrement=24, xscrollincrement=24)
        self.canvas.grid(row=0, column=0, sticky='nsew')
        vertical = ttk.Scrollbar(self, orient='vertical', command=self.canvas.yview)
        vertical.grid(row=0, column=1, sticky='ns')
        horizontal = ttk.Scrollbar(self, orient='horizontal', command=self.canvas.xview)
        horizontal.grid(row=1, column=0, sticky='ew')
        self.canvas.configure(yscrollcommand=vertical.set, xscrollcommand=horizontal.set)
        self.body = ttk.Frame(self.canvas, padding=(24, 16))
        self.window = self.canvas.create_window(0, 0, window=self.body, anchor='nw')
        self.canvas.bind('<Configure>', self._resize)
        self.body.bind('<Configure>', self._resize)
        self._wheel_remainder = {False: 0, True: 0}
        # Route wheel input before native widget bindings can consume it.
        self._top = self.winfo_toplevel()
        self._wheel_tag = f"WorkspaceWheel{id(self)}"
        self._bindings = {sequence: self._top.bind_class(self._wheel_tag, sequence, self._wheel)
                          for sequence in ('<MouseWheel>', '<Shift-MouseWheel>',
                                           '<Button-4>', '<Button-5>')}
        self.bind('<Destroy>', self._cleanup)

    def _resize(self, _event=None):
        width = max(self.canvas.winfo_width(), self.body.winfo_reqwidth())
        height = max(self.canvas.winfo_height(), self.body.winfo_reqheight())
        self.canvas.itemconfigure(self.window, width=width, height=height)
        self.canvas.configure(scrollregion=(0, 0, width, height))

    def install_wheel_bindings(self):
        def visit(widget):
            tags = widget.bindtags()
            if self._wheel_tag not in tags:
                widget.bindtags((self._wheel_tag,) + tags)
            for child in widget.winfo_children():
                visit(child)
        visit(self._top)

    def _wheel(self, event):
        widget = event.widget
        # Windows may send wheel events to the focused widget, not the hovered one.
        if hasattr(event, 'x_root') and hasattr(event, 'y_root'):
            hovered = self.winfo_containing(event.x_root, event.y_root)
            if hovered is not None:
                widget = hovered
        horizontal = bool(event.state & 0x0001)
        delta = -120 if getattr(event, 'num', None) == 5 else 120 if getattr(event, 'num', None) == 4 else event.delta
        if not delta:
            return
        if isinstance(widget, ttk.Combobox) and widget.instate(['pressed']):
            return
        target = self.canvas
        if isinstance(widget, (tk.Text, ttk.Treeview, tk.Listbox)):
            start, end = widget.xview() if horizontal else widget.yview()
            # At the edge of an inner pane, continue scrolling the workspace.
            if (delta > 0 and start > 0) or (delta < 0 and end < 1):
                target = widget
        self._wheel_remainder[horizontal] += delta
        steps = int(self._wheel_remainder[horizontal] / 120)
        self._wheel_remainder[horizontal] -= steps * 120
        if steps:
            scroll = target.xview_scroll if horizontal else target.yview_scroll
            scroll(-steps * 3, 'units')
        return 'break'

    def _cleanup(self, event):
        if event.widget == self:
            for sequence, binding in self._bindings.items():
                self._top.unbind_class(self._wheel_tag, sequence)


def build_workspace(app):
    root = app.root
    root.geometry(f'{min(1440, root.winfo_screenwidth() - 80)}x{min(960, root.winfo_screenheight() - 120)}')
    root.minsize(640, 480)
    root.configure(background=BG)
    root.option_add('*Font', ('Segoe UI', 10))
    style = ttk.Style(root)
    style.theme_use('clam')
    style.configure('.', font=('Segoe UI', 10), background=BG, foreground=INK)
    style.configure('TFrame', background=BG)
    style.configure('Card.TFrame', background='white')
    style.configure('TLabel', background=BG, foreground=INK)
    style.configure('Card.TLabel', background='white')
    style.configure('Muted.TLabel', foreground=MUTED)
    style.configure('Title.TLabel', font=('Segoe UI', 24, 'bold'))
    style.configure('Section.TLabel', font=('Segoe UI', 12, 'bold'), background='white')
    style.configure('Metric.TLabel', font=('Segoe UI', 23, 'bold'), background='white')
    style.configure('TButton', padding=(12, 8), background='white', borderwidth=1)
    style.map('TButton', background=[('active', '#E4EEF2')], foreground=[('disabled', '#8B98A5')])
    style.configure('Primary.TButton', background=TEAL, foreground='white', borderwidth=0)
    style.map('Primary.TButton', background=[('disabled', '#C9D6DE'), ('active', '#06666A')], foreground=[('disabled', '#617487')])
    style.configure('TEntry', padding=7, fieldbackground='white')
    style.configure('TCombobox', padding=6, fieldbackground='white')
    style.configure('Treeview', background='white', fieldbackground='white', rowheight=36, borderwidth=0)
    style.configure('Treeview.Heading', background='#EAF0F5', padding=(8, 10), font=('Segoe UI', 9, 'bold'))
    style.map('Treeview', background=[('selected', '#D7EFEE')], foreground=[('selected', INK)])
    style.configure('Horizontal.TProgressbar', background=TEAL, troughcolor='#DFE7EE', borderwidth=0)

    header = tk.Frame(root, bg=INK, padx=24, pady=12)
    header.pack(fill='x')
    tk.Label(header, text='II  /  INSPECTION INTELLIGENCE', bg=INK, fg='white', font=('Segoe UI', 11, 'bold')).pack(side='left')
    tk.Label(header, text='PHOTO WORKSPACE    •    LOCAL PROCESSING', bg=INK, fg='#BBD4DF').pack(side='right')
    app.workspace = ScrollableWorkspace(root)
    app.workspace.pack(fill='both', expand=True)
    body = app.workspace.body
    title = ttk.Frame(body)
    title.pack(fill='x', pady=(0, 14))
    ttk.Label(title, text='Inspection workspace', style='Title.TLabel').pack(side='left')
    app.export_button = ttk.Button(title, text='Export Excel', command=app._export, state='disabled')
    app.export_button.pack(side='right')
    app.mode_var = tk.StringVar(value='Fast local sorting' if app.configuration.processing_mode == 'fast' else 'Detailed local AI')
    app.mode_box = ttk.Combobox(title, textvariable=app.mode_var, state='readonly', width=22,
                               values=('Fast local sorting', 'Detailed local AI'))
    app.mode_box.pack(side='right', padx=(12, 12))

    setup = ttk.Frame(body, style='Card.TFrame', padding=16)
    setup.pack(fill='x')
    setup.columnconfigure(2, weight=1)
    for column, label in enumerate(('Vessel name', 'Inspection date · YYYY-MM-DD', 'Photo folder · JPG, JPEG, PNG')):
        ttk.Label(setup, text=label, style='Card.TLabel').grid(row=0, column=column, sticky='w', pady=(0, 6))
    app.vessel_entry = ttk.Entry(setup, width=24)
    app.vessel_entry.grid(row=1, column=0, sticky='ew', padx=(0, 14))
    app.date_entry = ttk.Entry(setup, width=24)
    app.date_entry.insert(0, date.today().isoformat())
    app.date_entry.grid(row=1, column=1, sticky='ew', padx=(0, 14))
    app.folder_var = tk.StringVar()
    app.folder_entry = ttk.Entry(setup, textvariable=app.folder_var)
    app.folder_entry.grid(row=1, column=2, sticky='ew', padx=(0, 8))
    app.select_button = ttk.Button(setup, text='Browse…', command=app._select_folder)
    app.select_button.grid(row=1, column=3)
    app.analyse_button = ttk.Button(setup, text='Analyse inspection', style='Primary.TButton', command=app._start_analysis)
    app.analyse_button.grid(row=1, column=4, padx=(14, 0))
    progress = ttk.Frame(body)
    progress.pack(fill='x', pady=12)
    app.progress_label = ttk.Label(progress, text='Ready · Add a vessel and photo folder to begin.', style='Muted.TLabel')
    app.progress_label.pack(side='left')
    app.progress_bar = ttk.Progressbar(progress, length=220)
    app.progress_bar.pack(side='right')
    app.stop_button = ttk.Button(progress, text='Stop after current photo',
                                 command=app._stop_analysis, state='disabled')
    app.stop_button.pack(side='right', padx=(8, 12))

    metrics = ttk.Frame(body)
    metrics.pack(fill='x', pady=(0, 12))
    app.metric_values = {}
    for column, (key, label) in enumerate((('total', 'PHOTOGRAPHS'), ('processed', 'PROCESSED'), ('pending', 'PENDING REVIEW'), ('failed', 'FAILED'))):
        metrics.columnconfigure(column, weight=1, uniform='metric')
        card = ttk.Frame(metrics, style='Card.TFrame', padding=(16, 8))
        card.grid(row=0, column=column, sticky='ew', padx=(0, 10 if column < 3 else 0))
        ttk.Label(card, text=label, style='Card.TLabel', foreground=MUTED, font=('Segoe UI', 9, 'bold')).pack(anchor='w')
        app.metric_values[key] = tk.StringVar(value='0')
        ttk.Label(card, textvariable=app.metric_values[key], style='Metric.TLabel').pack(anchor='w')

    app.notebook = ttk.Notebook(body)
    app.notebook.pack(fill='both', expand=True)
    review = ttk.Frame(app.notebook, padding=14, style='Card.TFrame')
    logs = ttk.Frame(app.notebook, padding=14, style='Card.TFrame')
    app.notebook.add(review, text='  Photo review  ')
    app.notebook.add(logs, text='  Activity log  ')
    review.columnconfigure(0, weight=1)
    review.columnconfigure(1, minsize=350)
    review.rowconfigure(1, weight=1)
    toolbar = ttk.Frame(review, style='Card.TFrame')
    toolbar.grid(row=0, column=0, sticky='ew', padx=(0, 16), pady=(0, 12))
    ttk.Label(toolbar, text='Photographs', style='Section.TLabel').pack(side='left')
    app.search_var = tk.StringVar()
    ttk.Label(toolbar, text='Search', style='Card.TLabel').pack(side='left', padx=(18, 6))
    ttk.Entry(toolbar, textvariable=app.search_var, width=19).pack(side='left', fill='x', expand=True)
    app.filter_var = tk.StringVar(value='All photos')
    ttk.Combobox(toolbar, textvariable=app.filter_var, values=('All photos', 'Pending review', 'Reviewed', 'Failed'), state='readonly', width=16).pack(side='left', padx=(8, 0))
    table = ttk.Frame(review, style='Card.TFrame')
    table.grid(row=1, column=0, sticky='nsew', padx=(0, 16))
    table.columnconfigure(0, weight=1)
    table.rowconfigure(0, weight=1)
    columns = ('filename', 'ai_level1', 'confidence', 'processing_time', 'status', 'review_status')
    app.tree = ttk.Treeview(table, columns=columns, show='headings', selectmode='browse')
    for key, label, width in zip(columns, ('Photo name', 'AI classification', 'Confidence', 'Time (ms)', 'Status', 'Review'), (190, 160, 90, 80, 85, 100)):
        app.tree.heading(key, text=label)
        app.tree.column(key, width=width, minwidth=65, stretch=key in ('filename', 'ai_level1'))
    app.tree.grid(row=0, column=0, sticky='nsew')
    for orientation, row, column, sticky, command in [('vertical', 0, 1, 'ns', app.tree.yview), ('horizontal', 1, 0, 'ew', app.tree.xview)]:
        bar = ttk.Scrollbar(table, orient=orientation, command=command)
        bar.grid(row=row, column=column, sticky=sticky)
        app.tree.configure(**{('yscrollcommand' if orientation == 'vertical' else 'xscrollcommand'): bar.set})
    app.tree.tag_configure('failed', foreground='#A33D32')
    app.tree.tag_configure('alternate', background='#F6F9FB')
    app.empty_label = ttk.Label(table, text='Your inspection starts here\n\nChoose a photo folder, then select Analyse inspection.\nResults will appear here for review.', justify='center', anchor='center', style='Card.TLabel', foreground=MUTED)
    app.empty_label.place(relx=.5, rely=.5, anchor='center')
    app.tree.bind('<<TreeviewSelect>>', app._show_selected)

    details = ttk.Frame(review, style='Card.TFrame', width=350)
    details.grid(row=0, column=1, rowspan=2, sticky='nsew')
    ttk.Label(details, text='Photo details', style='Section.TLabel').pack(anchor='w', pady=(0, 10))
    preview = tk.Frame(details, background='#EAF0F5', height=190, width=340)
    preview.pack(fill='x')
    preview.pack_propagate(False)
    app.image_label = tk.Label(preview, text='Select a photograph to review', bg='#EAF0F5', fg=MUTED, wraplength=310)
    app.image_label.pack(fill='both', expand=True)
    app.detail_filename = ttk.Label(details, text='', style='Card.TLabel', wraplength=340, font=('Segoe UI', 10, 'bold'))
    app.detail_filename.pack(anchor='w', pady=(10, 4))
    app.final_label = ttk.Label(details, text='Final classification: —', style='Card.TLabel', wraplength=340)
    app.final_label.pack(anchor='w')
    ttk.Label(details, text='AI reasoning', style='Card.TLabel', foreground=MUTED).pack(anchor='w', pady=(10, 4))
    app.reason_text = ScrolledText(details, height=3, width=36, wrap='word', state='disabled', relief='flat', bg='#F2F5F8', fg=INK, padx=8, pady=8)
    app.reason_text.pack(fill='both', expand=True)
    ttk.Label(details, text='Reviewer classification', style='Card.TLabel').pack(anchor='w', pady=(10, 4))
    app.classification_var = tk.StringVar()
    app.classification_box = ttk.Combobox(details, textvariable=app.classification_var, values=app.configuration.taxonomy.values, state='disabled')
    app.classification_box.pack(fill='x')
    actions = ttk.Frame(details, style='Card.TFrame')
    actions.pack(fill='x', pady=(10, 0))
    app.approve_button = ttk.Button(actions, text='Approve AI', command=app._approve, style='Primary.TButton', state='disabled')
    app.approve_button.pack(side='left')
    app.change_button = ttk.Button(actions, text='Save classification', command=app._change_classification, state='disabled')
    app.change_button.pack(side='right')
    app.summary_label = ttk.Label(body, text='Original photos stay untouched. Subfolders are included.', style='Muted.TLabel', wraplength=1250)
    app.summary_label.pack(anchor='w', pady=(10, 0))
    ttk.Button(logs, text='Open log folder', command=app._open_log_folder).pack(anchor='e', pady=(0, 8))
    app.log_text = ScrolledText(logs, wrap='word', state='normal', relief='flat', bg='#F2F5F8', fg=INK, padx=12, pady=12)
    app.log_text.pack(fill='both', expand=True)
    app.log_text.insert('end', f'Detailed log file: {app.log_path}\n')
    app.log_text.configure(state='disabled')
    app.search_var.trace_add('write', lambda *_: app._populate_results())
    app.filter_var.trace_add('write', lambda *_: app._populate_results())
    app.workspace.install_wheel_bindings()
    app.vessel_entry.focus_set()
