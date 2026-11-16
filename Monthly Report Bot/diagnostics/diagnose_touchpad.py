import tkinter as tk

root = tk.Tk()
root.title("Touchpad diagnostic")
root.geometry("520x180")
status = tk.StringVar(value="Place the pointer here and use two-finger scrolling")
tk.Label(root, textvariable=status, font=("Segoe UI", 12), wraplength=480).pack(expand=True, padx=20)

def wheel(event):
    widget = str(getattr(event, "widget", "?"))
    delta = getattr(event, "delta", 0)
    status.set(f"Wheel event received\nwidget: {widget}\ndelta: {delta}")
    return "break"

root.bind_all("<MouseWheel>", wheel, add="+")
root.bind_all("<Button-4>", wheel, add="+")
root.bind_all("<Button-5>", wheel, add="+")
try:
    root.bind_all("<TouchpadScroll>", wheel, add="+")
except tk.TclError:
    pass
root.mainloop()
