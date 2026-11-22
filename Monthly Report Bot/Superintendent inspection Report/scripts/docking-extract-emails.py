"""Digital Docking: unpack a past docking's daily report emails (.msg) for `pnpm docking:history`.

    python scripts/docking-extract-emails.py <folder with .msg files> <output folder>

Needs Outlook on this PC (the emails are opened with Outlook itself, read-only; nothing is sent or moved).
For each email "... Day N ..." (or "... Final ...") it writes <output>/dayNN/ (or final/) with:
  body.txt     the whole email text
  top.txt      only the new text of that email: up to the first quoted "From:" line, blank lines and the signature removed
  NN_<name>    every attachment as received (the vessel's Work Done workbook among them)
and <output>/summary.json with subject, sender and sent time per email.
Keep the output outside the source repository (real vessel data); a gitignored folder or this PC's temp folder is fine.
"""
import json
import os
import re
import sys

import win32com.client  # pywin32


def new_text(body):
    lines = []
    for line in body.splitlines():
        if line.startswith("From: "):
            break
        if re.match(r"\s*Thanks\s*&\s*Regards", line, re.I):
            break
        if line.strip():
            lines.append(line.rstrip())
    return "\n".join(lines) + "\n"


def main(src, out):
    src, out = os.path.abspath(src), os.path.abspath(out)  # Outlook needs absolute Windows paths
    os.makedirs(out, exist_ok=True)
    session = win32com.client.Dispatch("Outlook.Application").GetNamespace("MAPI")
    summary = []
    for name in sorted(os.listdir(src)):
        if not name.lower().endswith(".msg"):
            continue
        day = re.search(r"Day (\d+)", name)
        tag = f"day{int(day.group(1)):02d}" if day else ("final" if "final" in name.lower() else re.sub(r"\W+", "_", name[:20]))
        folder = os.path.join(out, tag)
        os.makedirs(folder, exist_ok=True)
        item = session.OpenSharedItem(os.path.join(src, name))
        try:
            body = item.Body or ""
            with open(os.path.join(folder, "body.txt"), "w", encoding="utf-8") as f:
                f.write(body)
            with open(os.path.join(folder, "top.txt"), "w", encoding="utf-8") as f:
                f.write(new_text(body))
            attachments = []
            for i in range(1, item.Attachments.Count + 1):
                attachment = item.Attachments.Item(i)
                saved = f"{i:02d}_" + re.sub(r'[\\/:*?"<>|]', "_", attachment.FileName or f"attachment{i}")
                attachment.SaveAsFile(os.path.join(folder, saved))
                attachments.append(saved)
            summary.append({"tag": tag, "file": name, "subject": item.Subject, "sender": str(item.SenderName), "sent": str(item.SentOn), "attachments": attachments})
            print(f"{tag}: {item.Subject} ({len(attachments)} attachments)")
        finally:
            item.Close(1)  # olDiscard: the .msg file is never changed
    with open(os.path.join(out, "summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=1, default=str)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
