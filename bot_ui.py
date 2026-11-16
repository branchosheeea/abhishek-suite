import threading
import tkinter as tk
from tkinter import messagebox, ttk

from Ver2_download import download_report

# ============================================================
# VESSEL LIST
# ============================================================

VESSELS = [
    "DHT ORYX",
    "DHT IMPALA",
    "DHT GAZELLE",
    "DHT ADDAX",
    "DHT ANTELOPE",
    "DHT APPALOOSA",
    "DHT MUSTANG",
    "DHT NOKOTA",
    "DHT BRONCO",
    "DHT COLT",
    "DHT STALLION",
    "DHT TIGER",
    "DHT HARRIER",
    "DHT PUMA",
    "DHT PANTHER",
    "DHT OSPREY",
    "DHT LION",
    "DHT LEOPARD",
    "DHT JAGUAR",
    "DHT TAIGA",
    "DHT OPAL",
    "DHT SUNDARBANS",
    "DHT REDWOOD",
    "DHT AMAZON",
]


# ============================================================
# REPORT LIST
# ============================================================

REPORTS = [
    "05.05.00.001- KPI - Ship Report",
    ("12.02.04.001 - Record Sheet for Ozone " "Depleting Substances (ODS)"),
    "Unmanned Engine Room Alarms Report",
    "15.01.01.001 - Drill Schedule",
    "M/E & A/E Cooling Water Test Log",
    "MGPS Monthly Log",
    "ICCP Monthly Log",
    ("12.02.10.001.01 - Waste Generation " "and Emission Statistics"),
    "14.36.00.001 - Stock of Paint Record",
    "12.04.07.021 - LO Stock and consumption report",
    "12.04.07.022 - LO analysis summary",
    "14.38.00.003 - Chief engineer's monthly report",
    "14.38.00.004 - Deck Monthly Maintenance report",
    ("15.01.01.002 - Evaluation reports for " "Drills & Training Exercises"),
    "Main Fire Alarm System Check",
    "Main Engine Running Hours",
    "Auxiliary Machinery Running Hours",
    "Life Buoy Inspection",
    ("Master and Chief engineer's " "Monthly verification"),
    "Auxiliary Engine Running Hours",
    "CRITICAL TEST AND CHECKS",
    "CRITICAL EQUIPMENT PERFORMANCE",
    "Boiler Feed Water test Log",
    "12.04.09.051 - Tail Shaft Monitoring Log",
    "12.06.02.001 - Monthly  HSQE Meeting",
    "14.01.01.011 - Master's Monthly Report",
    ("14.33.00.001 - Calibration of Portable " "Gas Meters and Measuring Equipment"),
    "Condition of Pressure & Temperature Gauges",
    ("14.05.04.001 - Report of Refrigerant, " "Chemical and Gases"),
    "024.01 Certificate Status",
    ("12.04.07.024 - On board " "Lubricating Oil Analysis"),
    "12.02.05.201 - Environmental Seal Log",
    "Monthly Oil Record Book Report 1M",
    "BWTS Operation Log Report",
    (
        "062.00 SEEMP III - Appendix D Minutes of "
        "CII Implementation Plan Review Committee Meeting"
    ),
    "Monthly verification of onboard tests",
]


# ============================================================
# APPLICATION STATE
# ============================================================

batch_running = False


# ============================================================
# GET SELECTED ITEMS
# ============================================================


def get_selected_items(listbox, source_list):

    selected_indices = listbox.curselection()

    return [source_list[index] for index in selected_indices]


# ============================================================
# START BATCH DOWNLOAD
# ============================================================


def start_download():

    global batch_running

    selected_vessels = get_selected_items(
        vessel_listbox,
        VESSELS,
    )

    selected_reports = get_selected_items(
        report_listbox,
        REPORTS,
    )

    if not selected_vessels:

        messagebox.showwarning(
            "Select Vessel",
            "Please select at least one vessel.",
        )

        return

    if not selected_reports:

        messagebox.showwarning(
            "Select Report",
            "Please select at least one report.",
        )

        return

    jobs = []

    for vessel_name in selected_vessels:

        for report_name in selected_reports:

            jobs.append(
                (
                    vessel_name,
                    report_name,
                )
            )

    total_jobs = len(jobs)

    confirmation = messagebox.askyesno(
        "Confirm Batch",
        (
            "Start the following download batch?\n\n"
            f"Vessels selected: {len(selected_vessels)}\n"
            f"Reports selected: {len(selected_reports)}\n"
            f"Total downloads: {total_jobs}"
        ),
    )

    if not confirmation:
        return

    batch_running = True

    set_controls_enabled(False)

    progress_bar["maximum"] = total_jobs
    progress_bar["value"] = 0

    progress_number_label.config(text=f"0 of {total_jobs} completed")

    status_label.config(
        text=(f"Starting batch of " f"{total_jobs} downloads..."),
        fg="#005a9e",
    )

    current_job_label.config(text="Preparing first download...")

    clear_results()

    add_result_line(
        (
            f"Batch started: "
            f"{len(selected_vessels)} vessel(s), "
            f"{len(selected_reports)} report(s), "
            f"{total_jobs} download(s)."
        )
    )

    worker = threading.Thread(
        target=run_batch,
        args=(jobs,),
        daemon=True,
    )

    worker.start()


# ============================================================
# RUN BATCH
# ============================================================


def run_batch(jobs):

    results = []
    total_jobs = len(jobs)

    for job_number, job in enumerate(
        jobs,
        start=1,
    ):

        vessel_name, report_name = job

        root.after(
            0,
            show_current_job,
            job_number,
            total_jobs,
            vessel_name,
            report_name,
        )

        try:

            result = download_report(
                vessel_name,
                report_name,
            )

            batch_result = {
                "vessel": vessel_name,
                "report": report_name,
                "status": "SUCCESS",
                "file_path": result.get(
                    "file_path",
                    "",
                ),
                "job_order_number": result.get(
                    "job_order_number",
                    "",
                ),
                "job_end_date": result.get(
                    "job_end_date",
                    "",
                ),
            }

            results.append(batch_result)

            root.after(
                0,
                add_job_result,
                batch_result,
            )

        except Exception as error:

            batch_result = {
                "vessel": vessel_name,
                "report": report_name,
                "status": "FAILED",
                "error": str(error),
            }

            results.append(batch_result)

            root.after(
                0,
                add_job_result,
                batch_result,
            )

        root.after(
            0,
            update_completed_count,
            job_number,
            total_jobs,
        )

    root.after(
        0,
        batch_completed,
        results,
    )


# ============================================================
# SHOW CURRENT JOB
# ============================================================


def show_current_job(
    job_number,
    total_jobs,
    vessel_name,
    report_name,
):

    status_label.config(
        text=(f"Processing download " f"{job_number} of {total_jobs}"),
        fg="#005a9e",
    )

    current_job_label.config(text=(f"Vessel: {vessel_name}\n" f"Report: {report_name}"))


# ============================================================
# UPDATE COMPLETED COUNT
# ============================================================


def update_completed_count(
    completed_jobs,
    total_jobs,
):

    progress_bar["value"] = completed_jobs

    progress_number_label.config(
        text=(f"{completed_jobs} of " f"{total_jobs} completed")
    )


# ============================================================
# ADD JOB RESULT
# ============================================================


def add_job_result(result):

    vessel_name = result["vessel"]
    report_name = result["report"]
    status = result["status"]

    if status == "SUCCESS":

        line = f"SUCCESS | {vessel_name} | " f"{report_name}"

        tag = "success"

    else:

        error_message = result.get(
            "error",
            "Unknown error",
        )

        line = f"FAILED | {vessel_name} | " f"{report_name} | {error_message}"

        tag = "failed"

    results_text.config(state="normal")

    results_text.insert(
        tk.END,
        line + "\n",
        tag,
    )

    results_text.see(tk.END)

    results_text.config(state="disabled")


# ============================================================
# BATCH COMPLETED
# ============================================================


def batch_completed(results):

    global batch_running

    batch_running = False

    set_controls_enabled(True)

    successful_results = [result for result in results if result["status"] == "SUCCESS"]

    failed_results = [result for result in results if result["status"] == "FAILED"]

    successful_count = len(successful_results)
    failed_count = len(failed_results)
    total_count = len(results)

    current_job_label.config(text="")

    if failed_count == 0:

        status_label.config(
            text=(
                "Batch completed successfully. "
                f"{successful_count} report(s) downloaded."
            ),
            fg="green",
        )

    else:

        status_label.config(
            text=("Batch completed with " f"{failed_count} failure(s)."),
            fg="#c65911",
        )

    add_result_line("")
    add_result_line("=" * 75)
    add_result_line(
        (
            f"BATCH COMPLETE | Total: {total_count} | "
            f"Successful: {successful_count} | "
            f"Failed: {failed_count}"
        )
    )
    add_result_line("=" * 75)

    summary_message = (
        "Batch processing completed.\n\n"
        f"Total downloads: {total_count}\n"
        f"Successful: {successful_count}\n"
        f"Failed: {failed_count}"
    )

    if failed_results:

        failed_summary = "\n\nFailed downloads:"

        for result in failed_results:

            failed_summary += (
                f"\n\n{result['vessel']}\n"
                f"{result['report']}\n"
                f"Reason: {result.get('error', 'Unknown error')}"
            )
        messagebox.showwarning(
            "Batch Completed",
            summary_message + failed_summary,
        )

    else:

        messagebox.showinfo(
            "Batch Completed",
            summary_message,
        )


# ============================================================
# CONTROL STATE
# ============================================================


def set_controls_enabled(enabled):

    if enabled:

        vessel_listbox.config(state="normal")

        report_listbox.config(state="normal")

        download_button.config(
            state="normal",
            text="DOWNLOAD SELECTED REPORTS",
        )

        vessel_select_all_button.config(state="normal")

        vessel_clear_button.config(state="normal")

        report_select_all_button.config(state="normal")

        report_clear_button.config(state="normal")

    else:

        vessel_listbox.config(state="disabled")

        report_listbox.config(state="disabled")

        download_button.config(
            state="disabled",
            text="DOWNLOADING...",
        )

        vessel_select_all_button.config(state="disabled")

        vessel_clear_button.config(state="disabled")

        report_select_all_button.config(state="disabled")

        report_clear_button.config(state="disabled")


# ============================================================
# SELECT AND CLEAR BUTTONS
# ============================================================


def select_all_vessels():

    vessel_listbox.select_set(
        0,
        tk.END,
    )


def clear_vessel_selection():

    vessel_listbox.selection_clear(
        0,
        tk.END,
    )


def select_all_reports():

    report_listbox.select_set(
        0,
        tk.END,
    )


def clear_report_selection():

    report_listbox.selection_clear(
        0,
        tk.END,
    )


# ============================================================
# RESULT LOG FUNCTIONS
# ============================================================


def add_result_line(line):

    results_text.config(state="normal")

    results_text.insert(
        tk.END,
        line + "\n",
    )

    results_text.see(tk.END)

    results_text.config(state="disabled")


def clear_results():

    results_text.config(state="normal")

    results_text.delete(
        "1.0",
        tk.END,
    )

    results_text.config(state="disabled")


# ============================================================
# CLOSE WINDOW
# ============================================================


def close_application():

    if batch_running:

        messagebox.showwarning(
            "Batch Running",
            (
                "A download batch is currently running.\n\n"
                "Please wait for the batch to finish "
                "before closing the application."
            ),
        )

        return

    root.destroy()


# ============================================================
# MAIN WINDOW
# ============================================================

root = tk.Tk()

root.title("Monthly Report Bot")

root.geometry("1200x820")

root.minsize(
    1050,
    700,
)

root.protocol(
    "WM_DELETE_WINDOW",
    close_application,
)


# ============================================================
# STYLE
# ============================================================

style = ttk.Style()

try:
    style.theme_use("vista")
except tk.TclError:
    pass

style.configure(
    "Horizontal.TProgressbar",
    thickness=18,
)


# ============================================================
# TITLE
# ============================================================

title_label = tk.Label(
    root,
    text="Monthly Report Bot",
    font=(
        "Segoe UI",
        22,
        "bold",
    ),
)

title_label.pack(pady=(20, 5))

instruction_label = tk.Label(
    root,
    text=(
        "Select one or more vessels and reports. "
        "Use Ctrl + Click to select individual items, "
        "or use the Select All buttons."
    ),
    font=(
        "Segoe UI",
        10,
    ),
    fg="#555555",
)

instruction_label.pack(pady=(0, 15))


# ============================================================
# SELECTION AREA
# ============================================================

selection_frame = tk.Frame(root)

selection_frame.pack(
    fill="both",
    expand=False,
    padx=25,
)


# ============================================================
# VESSEL SELECTION
# ============================================================

vessel_section = tk.LabelFrame(
    selection_frame,
    text="Select Vessels",
    font=(
        "Segoe UI",
        11,
        "bold",
    ),
    padx=10,
    pady=10,
)

vessel_section.pack(
    side="left",
    fill="both",
    expand=True,
    padx=(0, 10),
)

vessel_list_frame = tk.Frame(vessel_section)

vessel_list_frame.pack(
    fill="both",
    expand=True,
)

vessel_scrollbar = tk.Scrollbar(
    vessel_list_frame,
    orient="vertical",
)

vessel_scrollbar.pack(
    side="right",
    fill="y",
)

vessel_listbox = tk.Listbox(
    vessel_list_frame,
    selectmode=tk.EXTENDED,
    exportselection=False,
    font=(
        "Segoe UI",
        10,
    ),
    height=14,
    yscrollcommand=vessel_scrollbar.set,
)

vessel_listbox.pack(
    side="left",
    fill="both",
    expand=True,
)

vessel_scrollbar.config(command=vessel_listbox.yview)

for vessel in VESSELS:

    vessel_listbox.insert(
        tk.END,
        vessel,
    )

# Default selection for the first controlled test.
leopard_index = VESSELS.index("DHT LEOPARD")

vessel_listbox.selection_set(leopard_index)

vessel_listbox.see(leopard_index)

vessel_button_frame = tk.Frame(vessel_section)

vessel_button_frame.pack(pady=(10, 0))

vessel_select_all_button = tk.Button(
    vessel_button_frame,
    text="Select All",
    width=13,
    command=select_all_vessels,
)

vessel_select_all_button.pack(
    side="left",
    padx=5,
)

vessel_clear_button = tk.Button(
    vessel_button_frame,
    text="Clear",
    width=13,
    command=clear_vessel_selection,
)

vessel_clear_button.pack(
    side="left",
    padx=5,
)


# ============================================================
# REPORT SELECTION
# ============================================================

report_section = tk.LabelFrame(
    selection_frame,
    text="Select Reports",
    font=(
        "Segoe UI",
        11,
        "bold",
    ),
    padx=10,
    pady=10,
)

report_section.pack(
    side="left",
    fill="both",
    expand=True,
    padx=(10, 0),
)

report_list_frame = tk.Frame(report_section)

report_list_frame.pack(
    fill="both",
    expand=True,
)

report_scrollbar = tk.Scrollbar(
    report_list_frame,
    orient="vertical",
)

report_scrollbar.pack(
    side="right",
    fill="y",
)

report_listbox = tk.Listbox(
    report_list_frame,
    selectmode=tk.EXTENDED,
    exportselection=False,
    font=(
        "Segoe UI",
        10,
    ),
    height=14,
    yscrollcommand=report_scrollbar.set,
)

report_listbox.pack(
    side="left",
    fill="both",
    expand=True,
)

report_scrollbar.config(command=report_listbox.yview)

for report in REPORTS:

    report_listbox.insert(
        tk.END,
        report,
    )

# Default selection for the first controlled test.
main_engine_index = REPORTS.index("Main Engine Running Hours")

report_listbox.selection_set(main_engine_index)

report_listbox.see(main_engine_index)

report_button_frame = tk.Frame(report_section)

report_button_frame.pack(pady=(10, 0))

report_select_all_button = tk.Button(
    report_button_frame,
    text="Select All",
    width=13,
    command=select_all_reports,
)

report_select_all_button.pack(
    side="left",
    padx=5,
)

report_clear_button = tk.Button(
    report_button_frame,
    text="Clear",
    width=13,
    command=clear_report_selection,
)

report_clear_button.pack(
    side="left",
    padx=5,
)


# ============================================================
# DOWNLOAD BUTTON
# ============================================================

download_button = tk.Button(
    root,
    text="DOWNLOAD SELECTED REPORTS",
    font=(
        "Segoe UI",
        11,
        "bold",
    ),
    width=32,
    height=2,
    command=start_download,
)

download_button.pack(pady=(20, 12))


# ============================================================
# PROGRESS AREA
# ============================================================

progress_frame = tk.Frame(root)

progress_frame.pack(
    fill="x",
    padx=35,
)

progress_bar = ttk.Progressbar(
    progress_frame,
    orient="horizontal",
    mode="determinate",
    style="Horizontal.TProgressbar",
)

progress_bar.pack(
    fill="x",
)

progress_number_label = tk.Label(
    progress_frame,
    text="0 of 0 completed",
    font=(
        "Segoe UI",
        9,
    ),
    fg="#555555",
)

progress_number_label.pack(pady=(5, 0))

status_label = tk.Label(
    root,
    text="Ready",
    font=(
        "Segoe UI",
        11,
        "bold",
    ),
    fg="gray",
)

status_label.pack(pady=(8, 2))

current_job_label = tk.Label(
    root,
    text="",
    font=(
        "Segoe UI",
        9,
    ),
    fg="#333333",
    wraplength=1050,
    justify="center",
)

current_job_label.pack(pady=(0, 8))


# ============================================================
# RESULTS LOG
# ============================================================

results_frame = tk.LabelFrame(
    root,
    text="Batch Results",
    font=(
        "Segoe UI",
        10,
        "bold",
    ),
    padx=8,
    pady=8,
)

results_frame.pack(
    fill="both",
    expand=True,
    padx=25,
    pady=(5, 20),
)

results_scrollbar = tk.Scrollbar(
    results_frame,
    orient="vertical",
)

results_scrollbar.pack(
    side="right",
    fill="y",
)

results_text = tk.Text(
    results_frame,
    height=10,
    wrap="word",
    font=(
        "Consolas",
        9,
    ),
    state="disabled",
    yscrollcommand=results_scrollbar.set,
)

results_text.pack(
    side="left",
    fill="both",
    expand=True,
)

results_scrollbar.config(command=results_text.yview)

results_text.tag_configure(
    "success",
    foreground="green",
)

results_text.tag_configure(
    "failed",
    foreground="red",
)


# ============================================================
# START APPLICATION
# ============================================================

root.mainloop()
