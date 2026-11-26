"""CustomTkinter user interface for Guarantee Claim Manager."""
from __future__ import annotations
from datetime import date, datetime
import json
import os
from pathlib import Path
import queue
import sqlite3
import threading
import time
import tkinter as tk
from tkinter import ttk, filedialog, messagebox, simpledialog
import customtkinter as ctk

from .repository import Repository
from .rules import STATUS, WAITING_ON, LABELS
from .outlook import ReadOnlyGraphAdapter, import_fixture, import_msg_archive

BG="#F5F6F8"; WHITE="#FFFFFF"; INK="#15191E"; MUTED="#737A84"; TEAL="#0C796F"; RED="#B42318"; AMBER="#9A6700"


def sync_summary(result):
    """What a sync read, with the other folders that had messages, so missing folders can be spotted."""
    folders=result.get("folders") or {}; read={name:count for name,count in folders.items() if count}
    lines=[f"New GC emails added: {result.get('added',0)}","","Messages read (headers):",f"Inbox: {result.get('inbox',0)}",f"Sent Items: {result.get('sentitems',0)}",f"Other folders: {sum(folders.values())} in {len(folders)} folder(s)"]
    lines+=[f"   {name}: {count}" for name,count in list(read.items())[:25]]
    if len(read)>25: lines.append(f"   ... and {len(read)-25} more")
    return "\n".join(lines)


def local_time(value):
    """A stored UTC time as this PC's local time, e.g. 25 Nov 2026, 10:02 pm."""
    try: moment=datetime.fromisoformat(value).astimezone()
    except (TypeError,ValueError): return str(value or "")
    return f"{moment.day} {moment:%b %Y}, {moment.hour%12 or 12}:{moment:%M} {'am' if moment.hour<12 else 'pm'}"


class GCApp(ctk.CTk):
    def __init__(self, data_root=None):
        super().__init__()
        self.repo=Repository(data_root); self.title("Guarantee Claim Manager · NeraVeda")
        self.geometry("1180x780"); self.minsize(940,620); self.configure(fg_color=BG)
        self.events=queue.Queue(); self.syncing=False; self._sync_label_text="Syncing with Outlook"; self._sync_base=0; self._live_at=0.0
        header=ctk.CTkFrame(self,fg_color="transparent"); header.pack(fill="x",padx=24,pady=(18,8))
        ctk.CTkLabel(header,text="GUARANTEE CLAIM MANAGER",font=ctk.CTkFont(size=11,weight="bold"),text_color=TEAL).pack(anchor="w")
        ctk.CTkLabel(header,text="Claims, correspondence and daily attention",font=ctk.CTkFont(size=25,weight="bold"),text_color=INK).pack(anchor="w",pady=(3,0))
        self.tabs=ctk.CTkTabview(self,fg_color=BG,segmented_button_selected_color=TEAL,segmented_button_selected_hover_color="#09645C"); self.tabs.pack(fill="both",expand=True,padx=18,pady=(0,10))
        for name in ("Dashboard","Daily Attention","GC Register","Review Queue","Vessels","Settings"): self.tabs.add(name)
        self._build_dashboard(); self._build_register(); self._build_attention(); self._build_reviews(); self._build_vessels(); self._build_settings(); self.refresh_all()
        self._poll_after=self.after(300,self._poll_events); self._sync_after=self.after(300000,self._automatic_sync)

    def destroy(self):
        for name in ("_poll_after","_sync_after"):
            callback=getattr(self,name,None)
            if callback:
                try:self.after_cancel(callback)
                except tk.TclError:pass
        super().destroy()

    def button(self,parent,text,command,secondary=False):
        return ctk.CTkButton(parent,text=text,command=command,height=35,corner_radius=9,fg_color="#E9F5F2" if secondary else TEAL,hover_color="#DDEFEA" if secondary else "#09645C",text_color=TEAL if secondary else WHITE,font=ctk.CTkFont(size=12,weight="bold"))

    def _build_dashboard(self):
        page=self.tabs.tab("Dashboard")
        bar=ctk.CTkFrame(page,fg_color="transparent"); bar.pack(fill="x",pady=(2,12))
        self.sync_label=ctk.CTkLabel(bar,text="Outlook Not Configured",text_color=AMBER,font=ctk.CTkFont(size=12,weight="bold")); self.sync_label.pack(side="left")
        self.button(bar,"Sync Outlook Now",self.sync_now).pack(side="right")
        self.button(bar,"Import mock JSON",self.choose_fixture,secondary=True).pack(side="right",padx=8)
        self.button(bar,"Import .msg archive",self.choose_msg_archive,secondary=True).pack(side="right",padx=8)
        self.metric_labels={}
        self._tiles(page,(("stored","Emails stored"),("linked","Linked to claims"),("to_review","Emails to review"),("added_today","Added today")),compact=True)
        self.metrics=self._tiles(page,(("total","Total claims"),("open","Open"),("follow_up_due","Due today"),("overdue","Overdue"),("no_response","No response"),("awaiting_supply","Awaiting supply"),("in_transit","In transit"),("awaiting_verification","Awaiting verification"),("closure_pending","Closure pending"),("closed","Closed"),("guarantee_expiry_risks","Guarantee risk")))
        heading=ctk.CTkFrame(page,fg_color="transparent"); heading.pack(fill="x",pady=(14,6))
        ctk.CTkLabel(heading,text="Claims needing attention",font=ctk.CTkFont(size=16,weight="bold"),text_color=INK).pack(side="left")
        self.tracked_label=ctk.CTkLabel(heading,text="",font=ctk.CTkFont(size=12),text_color=MUTED); self.tracked_label.pack(side="right")
        self.att_tree=self._tree(page,("GC","Vessel","Status","Follow-up","Attention"),(100,190,210,120,300),height=8)
        self.att_tree.bind("<Double-1>",lambda _e:self.open_selected(self.att_tree))

    def _tiles(self,page,items,compact=False):
        frame=ctk.CTkFrame(page,fg_color="transparent"); frame.pack(fill="x")
        for idx,(key,label) in enumerate(items):
            tile=ctk.CTkFrame(frame,fg_color=WHITE,border_width=1,border_color="#E8EAED",corner_radius=12); tile.grid(row=idx//4,column=idx%4,sticky="ew",padx=4,pady=4)
            frame.grid_columnconfigure(idx%4,weight=1,uniform="tile")
            side={"side":"left","pady":3} if compact else {"anchor":"w","pady":(4,0)}
            ctk.CTkLabel(tile,text=label,text_color=MUTED,font=ctk.CTkFont(size=11)).pack(padx=12,**side)
            value=ctk.CTkLabel(tile,text="—",text_color=INK,font=ctk.CTkFont(size=18 if compact else 23,weight="bold"))
            value.pack(padx=12,**({"side":"right","pady":3} if compact else {"anchor":"w","pady":(0,5)})); self.metric_labels[key]=value
        return frame

    def _tree(self,parent,columns,widths,height=12):
        frame=ctk.CTkFrame(parent,fg_color=WHITE,corner_radius=10); frame.pack(fill="both",expand=True,pady=3)
        tree=ttk.Treeview(frame,columns=columns,show="headings",height=height)
        for col,w in zip(columns,widths): tree.heading(col,text=col,command=lambda c=col,t=tree:self._sort_tree(t,c)); tree.column(col,width=w,minwidth=60,stretch=True)
        scroll=ttk.Scrollbar(frame,orient="vertical",command=tree.yview); horizontal=ttk.Scrollbar(frame,orient="horizontal",command=tree.xview); tree.configure(yscrollcommand=scroll.set,xscrollcommand=horizontal.set); tree.pack(side="left",fill="both",expand=True,padx=(7,0),pady=7); scroll.pack(side="right",fill="y",padx=(0,7),pady=7);horizontal.pack(side="bottom",fill="x",padx=7,pady=(0,7))
        return tree

    @staticmethod
    def _sort_tree(tree,column):
        reverse=not getattr(tree,"_sort_reverse",False);tree._sort_reverse=reverse
        rows=[(tree.set(iid,column),iid) for iid in tree.get_children("")]
        rows.sort(key=lambda x:x[0].casefold(),reverse=reverse)
        for index,(_,iid) in enumerate(rows):tree.move(iid,"",index)

    @staticmethod
    def _fill(tree,rows,values):
        tree.delete(*tree.get_children())
        for row in rows: tree.insert("","end",iid=str(row["id"]),values=values(row))

    def _build_register(self):
        page=self.tabs.tab("GC Register")
        bar=ctk.CTkFrame(page,fg_color="transparent"); bar.pack(fill="x",pady=(0,6))
        self.search=tk.StringVar(); search=ctk.CTkEntry(bar,textvariable=self.search,placeholder_text="Search GC, vessel, title or equipment",width=310); search.pack(side="left"); search.bind("<KeyRelease>",lambda _e:self.refresh_register())
        self.status_filter=tk.StringVar(value="All")
        ctk.CTkOptionMenu(bar,variable=self.status_filter,values=["All",*STATUS],command=lambda _v:self.refresh_register()).pack(side="left",padx=8)
        self.button(bar,"Open selected",lambda:self.open_selected(self.claim_tree),secondary=True).pack(side="right")
        self.button(bar,"Register claim",self.create_claim).pack(side="right",padx=8)
        self.claim_tree=self._tree(page,("GC","Vessel","Title / equipment","Status","Waiting On","Reported","Age","Last incoming","Last outgoing","Follow-up","Promised / expected","Attention"),(85,145,170,170,115,100,55,130,130,105,135,190),15)
        self.claim_tree.bind("<Double-1>",lambda _e:self.open_selected(self.claim_tree))

    def _build_attention(self):
        page=self.tabs.tab("Daily Attention")
        ctk.CTkLabel(page,text="Sorted with overdue follow-ups first. Conditions remain visible as text labels.",text_color=MUTED).pack(anchor="w",pady=(4,8))
        self.daily_tree=self._tree(page,("GC","Vessel","Status","Follow-up","Attention"),(110,210,220,130,360),18)
        self.daily_tree.bind("<Double-1>",lambda _e:self.open_selected(self.daily_tree))

    def _build_reviews(self):
        page=self.tabs.tab("Review Queue")
        bar=ctk.CTkFrame(page,fg_color="transparent"); bar.pack(fill="x",pady=(0,8))
        ctk.CTkLabel(bar,text="Subject evidence is preserved; vessel corrections require an explicit review action.",text_color=MUTED).pack(side="left")
        self.button(bar,"Refresh",self.refresh_reviews,secondary=True).pack(side="right")
        self.review_tree=self._tree(page,("Type","Subject","Detected GC","Suggested vessel","Reason"),(180,340,130,180,350),15)
        self.review_tree.bind("<Double-1>",lambda _e:self.resolve_selected_review())
        actions=ctk.CTkFrame(page,fg_color="transparent"); actions.pack(fill="x",pady=7)
        self.button(actions,"Resolve selected",self.resolve_selected_review).pack(side="left")
        self.button(actions,"Mark irrelevant",lambda:self.resolve_selected_review(irrelevant=True),secondary=True).pack(side="left",padx=8)

    def _build_vessels(self):
        page=self.tabs.tab("Vessels")
        bar=ctk.CTkFrame(page,fg_color="transparent"); bar.pack(fill="x",pady=(0,8))
        self.button(bar,"Add vessel",self.add_vessel).pack(side="left")
        self.button(bar,"Edit guarantee dates",self.edit_vessel,secondary=True).pack(side="left",padx=8)
        self.vessel_tree=self._tree(page,("Name","Code","Guarantee start","Guarantee expiry","Close-out end","Active"),(280,120,150,150,150,100),16)

    def _build_settings(self):
        page=ctk.CTkScrollableFrame(self.tabs.tab("Settings"),fg_color="transparent"); page.pack(fill="both",expand=True)
        settings=self.repo.settings(); graph=bool(settings.get("graph_enabled")); configured=bool(settings.get("graph_configured"))
        self.settings_status=ctk.CTkLabel(page,text=f"Graph enabled: {'Yes' if graph else 'No'}   ·   Credentials configured: {'Yes' if configured else 'No'}   ·   Mock mode: Available",font=ctk.CTkFont(size=14,weight="bold"),text_color=INK); self.settings_status.pack(anchor="w",pady=(8,10))
        form=ctk.CTkFrame(page,fg_color=WHITE,corner_radius=12); form.pack(fill="x",pady=5)
        self.setting_vars={}
        setting_fields=(("standard_followup_days","Standard follow-up (days)"),("no_response_days","No-response escalation (days)"),("verification_days","Verification follow-up (days)"),("dispatch_followup_days","Dispatch follow-up (days)"),("delivery_followup_days","Delivery follow-up (days)"),("graph_sync_interval_minutes","Graph sync interval (minutes)"),("vessel_auto_match_threshold","Vessel auto-match threshold"),("vessel_review_threshold","Vessel review threshold"),("vessel_match_margin","Vessel score margin"))
        for i,(key,label) in enumerate(setting_fields):
            ctk.CTkLabel(form,text=label,text_color=INK).grid(row=i,column=0,sticky="w",padx=14,pady=8)
            var=tk.StringVar(value=str(settings.get(key,5))); self.setting_vars[key]=var
            ctk.CTkEntry(form,textvariable=var,width=100).grid(row=i,column=1,sticky="w",padx=14,pady=8)
        ctk.CTkLabel(form,text="Guarantee alert days (comma-separated; alert daily from the largest until expiry)",text_color=INK).grid(row=len(setting_fields),column=0,sticky="w",padx=14,pady=8)
        self.setting_vars["guarantee_alert_days"]=tk.StringVar(value=", ".join(map(str,settings.get("guarantee_alert_days",[90,60,30,14]))))
        ctk.CTkEntry(form,textvariable=self.setting_vars["guarantee_alert_days"],width=220).grid(row=len(setting_fields),column=1,sticky="w",padx=14,pady=8)
        ctk.CTkLabel(form,text="Vessels to track from Outlook (comma-separated; empty = all vessels)",text_color=INK).grid(row=len(setting_fields)+1,column=0,sticky="w",padx=14,pady=8)
        self.setting_vars["tracked_vessels"]=tk.StringVar(value=", ".join(settings.get("tracked_vessels") or []))
        ctk.CTkEntry(form,textvariable=self.setting_vars["tracked_vessels"],width=220).grid(row=len(setting_fields)+1,column=1,sticky="w",padx=14,pady=8)
        ctk.CTkLabel(page,text=f"Local user: {settings.get('local_user_name') or 'Not configured'}",text_color=MUTED).pack(anchor="w",pady=(9,3))
        self.button(page,"Save settings",self.save_settings).pack(anchor="w",pady=5)
        ctk.CTkLabel(page,text="Outlook access is read-only. Disconnect removes only the local encrypted token cache.",text_color=MUTED).pack(anchor="w",pady=(10,3))
        self.button(page,"Disconnect Outlook",self.disconnect,secondary=True).pack(anchor="w")

    def refresh_all(self):
        self.refresh_dashboard(); self.refresh_register(); self.refresh_attention(); self.refresh_reviews(); self.refresh_vessels()

    def refresh_dashboard(self):
        for key,value in self.repo.dashboard().items():
            if key in self.metric_labels:self.metric_labels[key].configure(text=str(value))
        self._fill_attention(self.att_tree,limit=10)
        self.tracked_label.configure(text="Emails shown for: "+(", ".join(self.repo.settings().get("tracked_vessels") or []) or "all vessels"))
        self.refresh_sync_status()

    def refresh_sync_status(self):
        """Email tiles and the Outlook line only, so it can run during a sync without disturbing tables or fields."""
        summary=self.repo.email_summary()
        for key,value in summary.items():self.metric_labels[key].configure(text=str(value))
        if self.syncing:
            self.sync_label.configure(text=f"{self._sync_label_text} · {max(0,summary['stored']-self._sync_base)} new emails so far",text_color=TEAL);return
        states=self.repo.sync_status()
        errors=[r["last_error"] for r in states if r.get("last_error")]
        success=[r["last_success_at"] for r in states if r.get("last_success_at")]
        if errors:text,color=f"Sync error: {errors[-1][:90]}",RED
        elif not self.repo.settings().get("graph_configured"):text,color="Outlook Not Configured",AMBER
        else:text,color="Outlook Connected"+(f" · Last sync {local_time(max(success))}" if success else ""),TEAL
        self.sync_label.configure(text=text,text_color=color)

    def _begin(self,label):
        self._sync_label_text=label; self._sync_base=self.repo.email_summary()["stored"]; self._live_at=time.monotonic(); self.syncing=True; self.refresh_dashboard()

    def refresh_register(self):
        if not hasattr(self,"claim_tree"):return
        rows=self.repo.claims(self.search.get(),self.status_filter.get())
        def values(c):
            flags=__import__("gc_manager.attention",fromlist=["calculate_attention"]).calculate_attention(c,self.repo.emails(c["id"]),self.repo.vessel(c["vessel_id"]),self.repo.settings())
            reported=c.get("date_reported")
            try:age=(date.today()-date.fromisoformat(str(reported)[:10])).days if reported else "—"
            except ValueError:age="—"
            incoming=(c.get("last_incoming_email") or "")[:16].replace("T"," ") or "—"
            outgoing=(c.get("last_outgoing_email") or "")[:16].replace("T"," ") or "—"
            return (c["gc_number"],c["vessel_name"],c["title"] or c["equipment_system"] or "—",LABELS[c["current_status"]],c["waiting_on"],reported or "—",age,incoming,outgoing,c["next_follow_up_date"] or "—",c.get("promised_or_expected_date") or "—",", ".join(flags) or "NORMAL")
        self._fill(self.claim_tree,rows,values)

    def refresh_attention(self):
        if hasattr(self,"daily_tree"): self._fill_attention(self.daily_tree)

    def _fill_attention(self,tree,limit=None):
        from .attention import SEVERITY
        items=[]
        for claim in self.repo.attention():
            flags=claim.get("attention",[]);rank=min((SEVERITY.index(f) for f in flags if f in SEVERITY),default=len(SEVERITY))
            values=(claim["gc_number"],claim["vessel_name"],LABELS[claim["current_status"]],claim.get("next_follow_up_date") or "—",", ".join(flags))
            items.append((rank,claim.get("next_follow_up_date") or "9999",("claim:"+str(claim["id"]),values)))
        review_rank={"NEW_EMAIL":4,"NEW_GC":5,"AMBIGUOUS_VESSEL":6,"UNMATCHED_GC_EMAIL":7,"MULTIPLE_GC_NUMBERS":8,"LINKING_ERROR":9}
        for review in self.repo.reviews():
            try:numbers=", ".join(json.loads(review["detected_gc_numbers_json"]))
            except Exception:numbers="—"
            items.append((review_rank.get(review["review_type"],8),review.get("created_at") or "9999",("review:"+str(review["id"]),(numbers,review.get("suggested_vessel") or "Vessel needs review",review["review_type"],review.get("created_at","")[:10],"REVIEW"))))
        items.sort(key=lambda x:(x[0],x[1]))
        tree.delete(*tree.get_children())
        for iid,values in [item[2] for item in items[:limit]] if limit else [item[2] for item in items]:tree.insert("","end",iid=iid,values=values)
    def refresh_reviews(self):
        if hasattr(self,"review_tree"):
            rows=self.repo.reviews()
            self._fill(self.review_tree,rows,lambda r:(r["review_type"],r["subject"],r["detected_gc_numbers_json"],r.get("suggested_vessel") or "Needs vessel selection",r["reason"]))
    def refresh_vessels(self):
        if hasattr(self,"vessel_tree"): self._fill(self.vessel_tree,self.repo.vessels(False),lambda v:(v["name"],v["code"],v.get("guarantee_start_date") or "—",v.get("guarantee_expiry_date") or "—",v.get("closeout_end_date") or "—","Yes" if v["active"] else "No"))

    def create_claim(self):
        self._claim_form()

    def _choose_vessel(self):
        values=self.repo.vessels()
        if not values: messagebox.showinfo("Vessel register","Add a vessel first.",parent=self); return None
        names=[f"{v['id']} · {v['name']}" for v in values]
        selected=simpledialog.askstring("Choose vessel","Enter one registered vessel name:\n"+"\n".join(v["name"] for v in values),parent=self)
        if not selected:return None
        found=next((v["id"] for v in values if v["name"].casefold()==selected.strip().casefold()),None)
        if not found:messagebox.showerror("Unknown vessel","Choose a canonical vessel name from the list.",parent=self)
        return found

    def add_vessel(self):
        name=simpledialog.askstring("Add vessel","Canonical vessel name:",parent=self)
        if not name:return
        code=simpledialog.askstring("Add vessel","Vessel code (optional):",parent=self) or ""
        try:self.repo.save_vessel(name,code); self.refresh_vessels()
        except Exception as e:messagebox.showerror("Could not save vessel",str(e),parent=self)

    def edit_vessel(self):
        selected=self.vessel_tree.selection()
        if not selected:messagebox.showinfo("Select a vessel","Select a vessel row first.",parent=self);return
        vessel=next((v for v in self.repo.vessels(False) if v["id"]==int(selected[0])),None)
        if not vessel:return
        start=simpledialog.askstring("Vessel guarantee dates","Guarantee start (YYYY-MM-DD):",initialvalue=vessel.get("guarantee_start_date") or "",parent=self)
        if start is None:return
        expiry=simpledialog.askstring("Vessel guarantee dates","Guarantee expiry (YYYY-MM-DD):",initialvalue=vessel.get("guarantee_expiry_date") or "",parent=self)
        if expiry is None:return
        closeout=simpledialog.askstring("Vessel guarantee dates","Post-guarantee close-out end (YYYY-MM-DD):",initialvalue=vessel.get("closeout_end_date") or "",parent=self)
        if closeout is None:return
        try:
            for value in (start,expiry,closeout):
                if value.strip():date.fromisoformat(value.strip())
            self.repo.save_vessel(vessel["name"],vessel["code"],start.strip() or None,expiry.strip() or None,closeout.strip() or None,vessel_id=vessel["id"],active=bool(vessel["active"]));self.refresh_vessels()
        except Exception as e:messagebox.showerror("Could not update vessel",str(e),parent=self)

    def open_selected(self,tree):
        selected=tree.selection()
        if not selected:return
        if selected[0].startswith("review:"):
            self.tabs.set("Review Queue");self.review_tree.selection_set(selected[0].split(":",1)[1]);self.review_tree.focus(selected[0].split(":",1)[1]);return
        claim_id=int(selected[0].split(":",1)[1]) if selected[0].startswith("claim:") else int(selected[0])
        try:claim=self.repo.claim(claim_id)
        except Exception:return
        win=ctk.CTkToplevel(self); win.title(f"{claim['gc_number']} · {claim['vessel_name']}"); win.geometry("900x700"); win.transient(self)
        ctk.CTkLabel(win,text=f"{claim['vessel_name']}   ·   {claim['gc_number']}",font=ctk.CTkFont(size=22,weight="bold")).pack(anchor="w",padx=18,pady=(16,3))
        ctk.CTkLabel(win,text=f"{LABELS[claim['current_status']]}   ·   Waiting on {claim['waiting_on']}   ·   Reported {claim.get('date_reported') or '—'}",text_color=MUTED).pack(anchor="w",padx=18)
        body=ctk.CTkTextbox(win,height=120); body.pack(fill="x",padx=18,pady=10); body.insert("1.0",f"Title / equipment: {claim['title']} / {claim['equipment_system']}\nDefect: {claim['defect_description']}\nResponsible party: {claim['responsible_party_name']}\nNext follow-up: {claim['next_follow_up_date']}\nPromised dispatch: {claim['promised_dispatch_date']}  Expected delivery: {claim['expected_delivery_date']}\nService attendance: {claim['service_attendance_date']}  Rectification: {claim['rectification_date']}\nNotes: {claim['notes']}"); body.configure(state="disabled")
        from .attention import calculate_attention
        flags=calculate_attention(claim,self.repo.emails(claim["id"]),self.repo.vessel(claim["vessel_id"]),self.repo.settings())
        ctk.CTkLabel(win,text="Attention: "+(", ".join(flags) if flags else "NORMAL"),text_color=RED if any(x in flags for x in ("OVERDUE","DELIVERY_OVERDUE")) else AMBER if flags else TEAL).pack(anchor="w",padx=18,pady=(0,5))
        actions=ctk.CTkFrame(win,fg_color="transparent"); actions.pack(fill="x",padx=18)
        self.button(actions,"Edit notes / dates",lambda:self.edit_claim(claim["id"],win)).pack(side="left")
        self.button(actions,"Change status",lambda:self.change_status(claim["id"],win),secondary=True).pack(side="left",padx=8)
        self.button(actions,"Undo last status",lambda:self.undo_status(claim["id"],win),secondary=True).pack(side="left",padx=8)
        self.button(actions,"Mark emails reviewed",lambda:self.mark_claim_emails_reviewed(claim["id"],win),secondary=True).pack(side="left",padx=8)
        if claim["current_status"]=="CLOSED":self.button(actions,"Reopen",lambda:self.reopen(claim["id"],win),secondary=True).pack(side="left")
        else:self.button(actions,"Close claim",lambda:self.close(claim["id"],win),secondary=True).pack(side="left")
        ctk.CTkLabel(win,text="Correspondence timeline",font=ctk.CTkFont(size=15,weight="bold")).pack(anchor="w",padx=18,pady=(8,3))
        timeline=ctk.CTkTextbox(win); timeline.pack(fill="both",expand=True,padx=18,pady=(0,10))
        for e in self.repo.timeline(claim["id"]): timeline.insert("end",f"{e['event_date']}  ·  {e['title']}\n{e['description']}\n\n")
        for e in self.repo.emails(claim["id"]): timeline.insert("end",f"SUBJECT: {e['subject']}\n{e['message_datetime']} · {e['direction']} · {e['sender_address']}\n{e['body_preview']}\n\n")
        timeline.configure(state="disabled")
        self.button(win,"Reassign correspondence",lambda:self.reassign_email(claim["id"],win),secondary=True).pack(anchor="w",padx=18,pady=(0,7))
        history=self.repo.history(claim["id"])
        if history:
            ctk.CTkLabel(win,text="Status history:  "+"  →  ".join(f"{h['new_status']} ({h['changed_at'][:10]} · {h['reason']})" for h in history),text_color=MUTED,wraplength=840).pack(anchor="w",padx=18,pady=(0,12))

    def edit_claim(self,claim_id,win):
        self._claim_form(self.repo.claim(claim_id),win)

    def _claim_form(self,claim=None,parent=None):
        edit=claim is not None
        form=ctk.CTkToplevel(parent or self); form.title("Edit claim" if edit else "Register guarantee claim");form.geometry("620x720");form.transient(parent or self)
        ctk.CTkLabel(form,text=f"Edit {claim['gc_number']}" if edit else "Register a guarantee claim",font=ctk.CTkFont(size=20,weight="bold")).pack(anchor="w",padx=18,pady=(16,4))
        ctk.CTkLabel(form,text=(claim["vessel_name"]+" · "+claim["gc_number"]) if edit else "Vessel and GC number form the permanent claim identity.",text_color=MUTED).pack(anchor="w",padx=18,pady=(0,7))
        scroll=ctk.CTkScrollableFrame(form,fg_color=BG);scroll.pack(fill="both",expand=True,padx=12,pady=6)
        variables={}; widgets={}
        fields=(
            ("title","Claim title"),("equipment_system","Equipment / system"),("defect_description","Defect description"),
            ("date_reported","Date reported (YYYY-MM-DD)"),("date_submitted","Date submitted (YYYY-MM-DD)"),
            ("waiting_on","Waiting On"),("responsible_party_name","Responsible party"),("assigned_to","Assigned to"),
            ("next_follow_up_date","Next follow-up (YYYY-MM-DD)"),("promised_dispatch_date","Promised dispatch (YYYY-MM-DD)"),
            ("expected_delivery_date","Expected delivery (YYYY-MM-DD)"),("service_attendance_date","Service attendance (YYYY-MM-DD)"),
            ("rectification_date","Rectification date (YYYY-MM-DD)"),("priority","Priority"),("notes","Notes"),
        )
        for key,label in fields:
            ctk.CTkLabel(scroll,text=label,text_color=INK).pack(anchor="w",padx=7,pady=(8,2))
            initial=(claim.get(key) or "") if edit else (date.today().isoformat() if key=="next_follow_up_date" else ("NORMAL" if key=="priority" else ("NONE" if key=="waiting_on" else "")))
            if key=="waiting_on":
                var=tk.StringVar(value=initial or "NONE");widget=ctk.CTkOptionMenu(scroll,variable=var,values=list(WAITING_ON),width=300)
            elif key=="notes":
                var=None;widget=ctk.CTkTextbox(scroll,height=90);widget.insert("1.0",initial)
            elif key=="defect_description":
                var=None;widget=ctk.CTkTextbox(scroll,height=80);widget.insert("1.0",initial)
            elif key=="priority":
                var=tk.StringVar(value=initial);widget=ctk.CTkOptionMenu(scroll,variable=var,values=["LOW","NORMAL","HIGH","URGENT"],width=300)
            else:
                var=tk.StringVar(value=initial);widget=ctk.CTkEntry(scroll,textvariable=var,width=440)
            widget.pack(anchor="w",padx=7)
            variables[key]=var;widgets[key]=widget
        if not edit:
            ctk.CTkLabel(scroll,text="Vessel",text_color=INK).pack(anchor="w",padx=7,pady=(8,2))
            vessels=self.repo.vessels()
            if not vessels:messagebox.showinfo("Vessel register","Add a vessel first.",parent=form);form.destroy();return
            names=[v["name"] for v in vessels];vessel_var=tk.StringVar(value=names[0]);ctk.CTkOptionMenu(scroll,variable=vessel_var,values=names,width=440).pack(anchor="w",padx=7)
            ctk.CTkLabel(scroll,text="GC number",text_color=INK).pack(anchor="w",padx=7,pady=(8,2))
            gc_var=tk.StringVar();ctk.CTkEntry(scroll,textvariable=gc_var,width=440,placeholder_text="GC-014").pack(anchor="w",padx=7)
        footer=ctk.CTkFrame(form,fg_color="transparent");footer.pack(fill="x",padx=18,pady=10)
        def save():
            values={k:(w.get("1.0","end").strip() if isinstance(w,ctk.CTkTextbox) else v.get().strip()) for k,w in widgets.items() for v in [variables[k]]}
            values={k:(v or None if k.endswith("_date") or k in {"date_reported","date_submitted"} else (v if v is not None else "")) for k,v in values.items()}
            try:
                for key,value in values.items():
                    if value and (key.endswith("_date") or key in {"date_reported","date_submitted"}):date.fromisoformat(value)
                if edit:self.repo.update_claim(claim["id"],**values)
                else:
                    vessel_id=next(v["id"] for v in vessels if v["name"]==vessel_var.get())
                    self.repo.create_claim(vessel_id,gc_var.get(),**values)
                form.destroy()
                if parent and parent.winfo_exists():parent.destroy()
                self.refresh_all()
            except Exception as e:messagebox.showerror("Could not save claim",str(e),parent=form)
        self.button(footer,"Save claim",save).pack(side="left")
        self.button(footer,"Cancel",form.destroy,secondary=True).pack(side="left",padx=8)
    def change_status(self,claim_id,win):
        status=simpledialog.askstring("Change status","Enter status value:\n"+", ".join(STATUS),parent=win)
        if not status:return
        status=status.strip().upper(); reason=simpledialog.askstring("Status reason","Reason (required for override):",parent=win) or ""
        try:self.repo.set_status(claim_id,status,reason); win.destroy(); self.refresh_all()
        except Exception as e:
            if "transition is not allowed" in str(e) and reason.strip() and messagebox.askyesno("Manual status override",f"This transition needs an override. Record this reason?\n\n{reason}",parent=win):
                try:self.repo.set_status(claim_id,status,reason,override=True);win.destroy();self.refresh_all()
                except Exception as override_error:messagebox.showerror("Could not change status",str(override_error),parent=win)
            else:messagebox.showerror("Could not change status",str(e),parent=win)
    def close(self,claim_id,win):
        reason=simpledialog.askstring("Close claim","Closure reason:",parent=win)
        if not reason:return
        try:self.repo.close_claim(claim_id,date.today().isoformat(),reason);win.destroy();self.refresh_all()
        except Exception as e:messagebox.showerror("Could not close claim",str(e),parent=win)
    def reopen(self,claim_id,win):
        reason=simpledialog.askstring("Reopen claim","Reopening reason:",parent=win)
        if not reason:return
        status=simpledialog.askstring("Reopen claim","Active status to resume into:",initialvalue="UNDER_REVIEW",parent=win) or "UNDER_REVIEW"
        try:self.repo.reopen_claim(claim_id,status.strip().upper(),reason);win.destroy();self.refresh_all()
        except Exception as e:messagebox.showerror("Could not reopen claim",str(e),parent=win)

    def undo_status(self,claim_id,win):
        reason=simpledialog.askstring("Undo status change","Reason for undo:",parent=win)
        if not reason:return
        try:self.repo.undo_last_manual_status_change(claim_id,reason);win.destroy();self.refresh_all()
        except Exception as e:messagebox.showerror("Could not undo status",str(e),parent=win)

    def mark_claim_emails_reviewed(self,claim_id,win):
        for email in self.repo.emails(claim_id):
            if not email.get("reviewed_at"):self.repo.mark_reviewed(email["id"])
        win.destroy();self.refresh_all()

    def reassign_email(self,old_claim_id,win):
        emails=self.repo.emails(old_claim_id)
        if not emails:messagebox.showinfo("No correspondence","This claim has no linked emails.",parent=win);return
        choices="\n".join(f"{e['id']} · {e['subject']}" for e in emails)
        raw=simpledialog.askstring("Choose correspondence","Enter the email ID to reassign:\n"+choices,parent=win)
        if not raw:return
        try:email_id=int(raw.strip())
        except ValueError:messagebox.showerror("Invalid email ID","Enter the numeric email ID shown in the list.",parent=win);return
        email=next((e for e in emails if e["id"]==email_id),None)
        if not email:return
        vessel_id=self._choose_vessel()
        if vessel_id is None:return
        target_claims=[c for c in self.repo.claims() if c["vessel_id"]==vessel_id]
        if not target_claims:messagebox.showinfo("No claims","Register the target claim first.",parent=win);return
        gc=simpledialog.askstring("Choose target claim","Enter target GC number:\n"+", ".join(c["gc_number"] for c in target_claims),parent=win)
        target=next((c for c in target_claims if c["gc_number"].casefold()==(gc or "").casefold()),None)
        if not target:return
        old=self.repo.claim(old_claim_id)
        if not messagebox.askyesno("Confirm email reassignment",f"Move this email?\n\n{old['vessel_name']} / {old['gc_number']} → {target['vessel_name']} / {target['gc_number']}\n\nSubject: {email['subject']}",parent=win):return
        reason=simpledialog.askstring("Reassignment reason","Reason (required and recorded in audit history):",parent=win)
        if not reason:return
        try:self.repo.reassign_email(email_id,target["id"],reason,old_claim_id);win.destroy();self.refresh_all()
        except Exception as e:messagebox.showerror("Could not reassign email",str(e),parent=win)

    def resolve_selected_review(self,irrelevant=False):
        selected=self.review_tree.selection()
        if not selected:return
        review_id=int(selected[0]); row=next((r for r in self.repo.reviews() if r["id"]==review_id),None)
        if not row:return
        notes=simpledialog.askstring("Review resolution","Resolution note:",parent=self) or ""
        if irrelevant:
            try:self.repo.resolve_review(review_id,"irrelevant",notes or "Marked irrelevant.");self.refresh_all()
            except Exception as e:messagebox.showerror("Could not resolve review",str(e),parent=self)
            return
        vessel_id=row.get("suggested_vessel_id")
        if row["review_type"]=="MULTIPLE_GC_NUMBERS":vessel_id=None
        if row["review_type"]!="MULTIPLE_GC_NUMBERS" and (not vessel_id or row["review_type"] in {"AMBIGUOUS_VESSEL","UNMATCHED_GC_EMAIL"}):
            vessel_id=self._choose_vessel()
            if vessel_id is None:return
        existing=[c for c in self.repo.claims() if c["vessel_id"]==vessel_id] if vessel_id is not None else self.repo.claims()
        options=[c for c in existing if c["gc_number"] in json.loads(row["detected_gc_numbers_json"])]
        if row["review_type"]=="MULTIPLE_GC_NUMBERS":
            if len(options)<2:
                messagebox.showinfo("Claims required","Create the intended vessel/GC claims first. Then select at least two here to link this email to all of them.",parent=self);return
            labels=[f"{c['id']} · {c['vessel_name']} · {c['gc_number']} · {c['title'] or 'No title'}" for c in options]
            selected=simpledialog.askstring("Link to multiple claims","Enter comma-separated claim IDs to link:\n"+"\n".join(labels),parent=self)
            if not selected:return
            try:
                ids=[int(value.strip()) for value in selected.split(",") if value.strip()]
                selected_claims=[c for c in options if c["id"] in ids]
                if len({c["vessel_id"] for c in selected_claims})>1 and not messagebox.askyesno("Confirm cross-vessel links","The selected claims belong to different vessels. Confirm that the subject evidence applies to all of them?",parent=self):return
                self.repo.resolve_multiple_gc_review(review_id,ids,notes);self.refresh_all()
            except Exception as e:messagebox.showerror("Could not link multiple claims",str(e),parent=self)
            return
        if row["review_type"]=="NEW_GC":
            register=messagebox.askyesno("Register new claim",f"Create the new claim for {row.get('suggested_vessel') or 'selected vessel'} and link this email?",parent=self)
            link_matching=False
            if register:
                matching_count=self.repo.matching_new_gc_review_count(review_id)
                if matching_count:
                    link_matching=messagebox.askyesno("Link matching archive messages",f"Also link {matching_count} other open emails whose subjects independently match this same vessel and GC number? Each link will be recorded in the audit history.",parent=self)
            try:
                linked=self.repo.resolve_review(review_id,"link",notes,vessel_id=vessel_id,register=register,claim_id=None if register else (options[0]["id"] if options else None),link_matching=link_matching)
                if link_matching and isinstance(linked,int) and linked>1:messagebox.showinfo("Matching messages linked",f"Registered the claim and linked {linked} matching email(s) to its timeline.",parent=self)
                self.refresh_all()
            except Exception as e:messagebox.showerror("Could not resolve review",str(e),parent=self)
            return
        if options:
            claim=options[0]
            if messagebox.askyesno("Link to claim",f"Link this email to {claim['vessel_name']} / {claim['gc_number']}?",parent=self):
                try:self.repo.resolve_review(review_id,"link",notes,vessel_id=vessel_id,claim_id=claim["id"]);self.refresh_all()
                except Exception as e:messagebox.showerror("Could not resolve review",str(e),parent=self)
            return
        if not existing:
            messagebox.showinfo("No matching claim",f"No claim exists for the selected vessel and subject GC numbers. Add a vessel and claim in the GC Register first.",parent=self);return
        choice=simpledialog.askstring("Choose claim","Enter the GC number to link:\n"+", ".join(c["gc_number"] for c in existing),parent=self)
        claim=next((c for c in existing if c["gc_number"].casefold()==(choice or "").casefold()),None)
        if claim:
            try:self.repo.resolve_review(review_id,"link",notes,vessel_id=vessel_id,claim_id=claim["id"]);self.refresh_all()
            except Exception as e:messagebox.showerror("Could not resolve review",str(e),parent=self)

    def choose_fixture(self):
        path=filedialog.askopenfilename(parent=self,title="Import mock Outlook JSON",filetypes=(("JSON files","*.json"),("All files","*.*")))
        if not path:return
        try:
            results=import_fixture(self.repo,path); imported=sum(1 for r in results if not r.get("duplicate") and not r.get("ignored")); messagebox.showinfo("Mock import complete",f"Processed {len(results)} message(s); imported {imported}.\nMode: local mock evidence.",parent=self); self.refresh_all()
        except Exception as e:messagebox.showerror("Mock import failed",str(e),parent=self)

    def choose_msg_archive(self):
        directory=filedialog.askdirectory(parent=self,title="Select the Outlook .msg archive folder")
        if not directory or self.syncing:return
        self._begin("Importing .msg files")
        def work():
            try:self.events.put(("archive_ok",import_msg_archive(self.repo,directory)))
            except Exception as e:self.events.put(("archive_error",str(e)))
        threading.Thread(target=work,daemon=True).start()

    def sync_now(self,automatic=False):
        if self.syncing:return
        settings=self.repo.settings()
        if not settings.get("graph_enabled") or not settings.get("graph_configured"):
            messagebox.showinfo("Outlook Not Configured","Set GC_GRAPH_ENABLED=true, AZURE_CLIENT_ID and AZURE_TENANT_ID to use read-only Microsoft Graph. You can import a local mock JSON fixture now.",parent=self);return
        from .sync import SyncBusy, is_running, run_sync
        if is_running(self.repo.root):  # the NeraVeda web helper (or another window) is syncing: one sync at a time
            if not automatic: messagebox.showinfo("Outlook sync","An Outlook sync is already running (NeraVeda web). Try again in a minute.",parent=self)
            return
        self.repo.sync_attempt();self._begin("Syncing with Outlook")
        def work():
            try:
                token_path=self.repo.root/"credentials"/"gc_msal_cache.bin"
                adapter=ReadOnlyGraphAdapter(os.getenv("AZURE_CLIENT_ID"),os.getenv("AZURE_TENANT_ID"),token_path)
                counts=run_sync(self.repo,adapter,prompt=lambda message:self._device_prompt(message),interactive=not automatic);self.events.put(("auto_sync" if automatic else "sync_ok",counts))
            except SyncBusy as e:self.events.put(("auto_sync" if automatic else "sync_error",str(e)))
            except Exception as e:self.events.put(("auto_sync" if automatic else "sync_error",str(e)))
        threading.Thread(target=work,daemon=True).start()

    def _device_prompt(self,message):
        done=threading.Event()
        def show():messagebox.showinfo("Microsoft sign-in",message,parent=self);done.set()
        self.after(0,show);done.wait()
    def _automatic_sync(self):
        settings=self.repo.settings()
        from .sync import recently_synced
        interval_minutes=max(1,int(settings.get("graph_sync_interval_minutes",5)))
        # The NeraVeda web helper also syncs on this schedule; skip when any program synced within the interval.
        if settings.get("graph_enabled") and settings.get("graph_configured") and not self.syncing and not recently_synced(self.repo,interval_minutes):self.sync_now(automatic=True)
        interval=max(1,int(settings.get("graph_sync_interval_minutes",5)))*60000;self._sync_after=self.after(interval,self._automatic_sync)
    def _poll_events(self):
        while not self.events.empty():
            kind,payload=self.events.get()
            self.syncing=False
            if kind=="auto_sync":pass  # no popup: the dashboard line shows the last sync or its error
            elif kind=="sync_ok":messagebox.showinfo("Outlook sync complete",sync_summary(payload),parent=self)
            elif kind=="archive_ok":
                imported=sum(1 for result in payload if not any(key in result for key in ("duplicate","ignored","error")))
                duplicates=sum(1 for result in payload if result.get("duplicate"))
                ignored=sum(1 for result in payload if result.get("ignored"))
                failures=sum(1 for result in payload if result.get("error"))
                messagebox.showinfo(".msg archive import complete",f"Processed {len(payload)} file(s)\nImported: {imported}\nDuplicates: {duplicates}\nIgnored: {ignored}\nErrors: {failures}\nOutlook messages were read only.",parent=self)
            elif kind=="archive_error":messagebox.showerror(".msg archive import failed",payload,parent=self)
            else:messagebox.showerror("Outlook sync failed",payload,parent=self)
            self.refresh_all()
        if self.syncing and time.monotonic()-self._live_at>=5:
            self._live_at=time.monotonic()
            try:self.refresh_sync_status()
            except sqlite3.OperationalError:pass  # the sync is writing: try again in 5 seconds
        self._poll_after=self.after(300,self._poll_events)
    def disconnect(self):
        token_path=self.repo.root/"credentials"/"gc_msal_cache.bin"
        if token_path.exists() and messagebox.askyesno("Disconnect Outlook","Clear the local encrypted authentication cache? Outlook will not be changed.",parent=self):token_path.unlink()
        self.refresh_dashboard()
    def save_settings(self):
        try:
            values={k:(sorted({int(day.strip()) for day in v.get().split(",") if day.strip()},reverse=True) if k=="guarantee_alert_days" else [name.strip() for name in v.get().split(",") if name.strip()] if k=="tracked_vessels" else int(v.get())) for k,v in self.setting_vars.items()}
            if any(v<1 for k,v in values.items() if k not in {"guarantee_alert_days","tracked_vessels"}):raise ValueError("Settings must be at least 1.")
            if any(not 1<=day<=365 for day in values["guarantee_alert_days"]):raise ValueError("Guarantee alert days must be between 1 and 365.")
            self.repo.save_settings(values);self.refresh_all();messagebox.showinfo("Settings saved","GC settings updated.",parent=self)
        except Exception as e:messagebox.showerror("Invalid settings",str(e),parent=self)


def main(data_root=None):
    app=GCApp(data_root); app.mainloop()
