"""Read-only Outlook boundary and local fixture importer."""
from __future__ import annotations
import json
import os
from pathlib import Path
import re
import time
from datetime import datetime
import urllib.error
import urllib.parse
import urllib.request

from .rules import extract_gc_numbers, identify_vessel, normalise_name

GRAPH_SCOPES = ("User.Read", "Mail.Read", "offline_access", "openid", "profile")
GRAPH_FORBIDDEN_SCOPES = ("Mail.ReadWrite", "Mail.Send")
GRAPH_MAIL = "https://graph.microsoft.com/v1.0/me"


class GraphError(RuntimeError):
    def __init__(self, message, code=None):
        super().__init__(message); self.code=code


def import_fixture(repository, path):
    """Import JSON message objects through the same production parser/linker."""
    path=Path(path)
    payload=json.loads(path.read_text(encoding="utf-8-sig"))
    messages=payload if isinstance(payload,list) else payload.get("messages")
    if not isinstance(messages,list): raise ValueError("Fixture must be a JSON array or an object with a messages array.")
    results=[]
    for message in messages:
        if not isinstance(message,dict): raise ValueError("Every fixture message must be a JSON object.")
        entry=dict(message); entry["source"]="mock_fixture"
        results.append(repository.import_message(entry))
    return results


def _outlook_archive_connection():
    """Connect to classic Outlook for reading locally exported .msg files."""
    try:
        import pythoncom
        from win32com.client import Dispatch
    except ImportError as error:
        raise RuntimeError("Importing .msg files requires pywin32 and classic Outlook for Windows.") from error
    pythoncom.CoInitialize()
    try:
        namespace = Dispatch("Outlook.Application").GetNamespace("MAPI")
    except Exception as error:
        pythoncom.CoUninitialize()
        raise RuntimeError("Could not connect to classic Outlook to read the .msg archive.") from error
    return namespace, pythoncom.CoUninitialize


def _mail_item_smtp_address(item):
    address = str(getattr(item, "SenderEmailAddress", "") or "").strip()
    if str(getattr(item, "SenderEmailType", "")).upper() == "EX":
        try:
            exchange_user = item.Sender.GetExchangeUser()
            address = str(exchange_user.PrimarySmtpAddress or address).strip()
        except Exception:
            try:
                address = str(item.PropertyAccessor.GetProperty(
                    "http://schemas.microsoft.com/mapi/proptag/0x39FE001F"
                ) or address).strip()
            except Exception:
                pass
    return address


def _mail_item_internet_id(item):
    try:
        return str(item.PropertyAccessor.GetProperty(
            "http://schemas.microsoft.com/mapi/proptag/0x1035001F"
        ) or "").strip()
    except Exception:
        return ""


def _as_iso_datetime(value):
    if not value:
        return ""
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def import_msg_archive(repository, directory, namespace_factory=None):
    """Import local Outlook .msg files as evidence without modifying Outlook.

    Direction is inferred by comparing each sender with the signed-in Outlook
    user's SMTP address. Messages without an Internet Message ID use the
    repository's stable subject/date/sender fallback for duplicate detection.
    """
    directory = Path(directory)
    files = sorted(directory.rglob("*.msg"), key=lambda path: str(path).casefold())
    if not files:
        raise ValueError(f"No .msg files were found in {directory}.")

    cleanup = None
    if namespace_factory is None:
        namespace, cleanup = _outlook_archive_connection()
    else:
        namespace = namespace_factory()

    results = []
    try:
        try:
            current_user = namespace.CurrentUser
            current_address = str(current_user.AddressEntry.GetExchangeUser().PrimarySmtpAddress or "").strip()
        except Exception:
            current_address = ""

        for path in files:
            try:
                item = namespace.OpenSharedItem(str(path.resolve()))
                if int(getattr(item, "Class", 43)) != 43:
                    results.append({"ignored": True, "reason": "Not an Outlook mail item.", "path": path.name})
                    continue

                sender = _mail_item_smtp_address(item)
                outgoing = bool(current_address and sender.casefold() == current_address.casefold())
                direction = "OUTGOING" if outgoing else ("INCOMING" if current_address else "UNKNOWN")
                folder = "Sent Items" if outgoing else ("Inbox" if current_address else "Mail Archive")
                message_datetime = _as_iso_datetime(
                    getattr(item, "SentOn", None) if outgoing else getattr(item, "ReceivedTime", None)
                )
                recipients = []
                for attribute in ("To", "CC"):
                    value = str(getattr(item, attribute, "") or "")
                    recipients.extend(part.strip() for part in re.split(r"[;,]", value) if part.strip())

                results.append(repository.import_message({
                    "internet_message_id": _mail_item_internet_id(item),
                    "conversation_id": str(getattr(item, "ConversationID", "") or ""),
                    "mailbox_folder": folder,
                    "direction": direction,
                    "subject": str(getattr(item, "Subject", "") or ""),
                    "sender_name": str(getattr(item, "SenderName", "") or ""),
                    "sender_address": sender,
                    "recipients": recipients,
                    "message_datetime": message_datetime,
                    "body": str(getattr(item, "Body", "") or ""),
                    "has_attachments": bool(getattr(getattr(item, "Attachments", None), "Count", 0)),
                    "source": "local_msg_archive",
                }))
            except Exception as error:
                results.append({"error": str(error), "path": path.name})
    finally:
        if cleanup:
            cleanup()
    return results


class ReadOnlyGraphAdapter:
    """Delegated, read-only Graph delta sync. Tokens stay in backend-protected local storage."""
    scopes=GRAPH_SCOPES
    api_scopes=("User.Read","Mail.Read")
    headers={"Prefer": 'IdType="ImmutableId", odata.maxpagesize=100'}

    def __init__(self, client_id=None, tenant_id=None, token_cache=None):
        self.client_id=client_id
        self.tenant_id=tenant_id
        self.token_cache=token_cache
        self._app=None
        self._token=None

    def _load_app(self):
        if self._app is not None: return self._app
        if not self.configured: raise RuntimeError("Outlook Not Configured. Set AZURE_CLIENT_ID and AZURE_TENANT_ID before Graph sync.")
        try:
            import msal
        except ImportError as error:
            raise RuntimeError("Microsoft Graph sync requires the optional msal package. Install the Suite requirements after review.") from error
        cache=msal.SerializableTokenCache()
        path=Path(self.token_cache) if self.token_cache else None
        if path and path.is_file():
            if os.name != "nt": raise RuntimeError("Encrypted Graph token cache is supported only on Windows.")
            try:
                import win32crypt
                encrypted=path.read_bytes()
                _, clear=win32crypt.CryptUnprotectData(encrypted,None,None,None,0)
                cache.deserialize(clear.decode("utf-8"))
            except Exception as error:
                raise RuntimeError(f"Could not unlock the local Graph token cache: {error}") from error
        authority=f"https://login.microsoftonline.com/{self.tenant_id}"
        self._app=msal.PublicClientApplication(self.client_id,authority=authority,token_cache=cache)
        return self._app

    def _save_cache(self, app):
        cache=app.token_cache
        if not cache.has_state_changed or not self.token_cache: return
        if os.name != "nt": raise RuntimeError("Encrypted Graph token cache is supported only on Windows.")
        import win32crypt
        path=Path(self.token_cache); path.parent.mkdir(parents=True,exist_ok=True)
        protected=win32crypt.CryptProtectData(cache.serialize().encode("utf-8"),"Abhishek Automation Suite GC token cache",None,None,None,0)
        temporary=path.with_suffix(path.suffix+".tmp"); temporary.write_bytes(protected); os.replace(temporary,path)

    def acquire_token(self, prompt=None, interactive=True, renew=False):
        app=self._load_app()
        accounts=app.get_accounts()
        result=app.acquire_token_silent(list(self.api_scopes),account=accounts[0],force_refresh=renew) if accounts else None
        if not result:
            if not interactive: raise RuntimeError("Microsoft sign-in needed. Choose Sync Outlook Now.")
            flow=app.initiate_device_flow(scopes=list(self.api_scopes))
            if "user_code" not in flow: raise RuntimeError("Could not start Microsoft device sign-in.")
            if prompt: prompt(flow.get("message","Complete Microsoft sign-in in your browser."))
            result=app.acquire_token_by_device_flow(flow)
        self._save_cache(app)
        if "access_token" not in result: raise RuntimeError(result.get("error_description") or "Microsoft sign-in did not return an access token.")
        return result["access_token"]

    @staticmethod
    def _request(url, token):
        request=urllib.request.Request(url,headers={"Authorization":f"Bearer {token}","Accept":"application/json",**ReadOnlyGraphAdapter.headers})
        for attempt in range(5):
            try:
                with urllib.request.urlopen(request,timeout=45) as response: return json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as error:
                if error.code in (429,503,504) and attempt<4:
                    wait=str(error.headers.get("Retry-After") or "")
                    time.sleep(min(int(wait) if wait.isdigit() else 2**attempt,60)); continue
                detail=error.read().decode("utf-8","replace")[:1200]
                raise GraphError(f"Microsoft Graph returned HTTP {error.code}: {detail}",error.code) from error

    def _get(self, url):
        """One read. A token lasts about an hour, so a long sync renews it, without a sign-in, and repeats the read once."""
        try: return self._request(url,self._token)
        except GraphError as error:
            if error.code!=401: raise
        self._token=self.acquire_token(interactive=False,renew=True)
        return self._request(url,self._token)

    @property
    def configured(self):
        return bool(self.client_id and self.tenant_id)

    def _pages(self, url):
        while url:
            page=self._get(url)
            yield page
            url=page.get("@odata.nextLink")

    def _other_folders(self, vessels, tracked=None):
        """[(folder id, path)]: every folder under Inbox, and vessel-named folders elsewhere with their subfolders.

        A folder named after a vessel that is not tracked is left out with its subfolders.
        """
        known={}
        for name in ("inbox","sentitems","deleteditems","junkemail","drafts","outbox"):
            try: known[name]=self._get(f"{GRAPH_MAIL}/mailFolders/{name}?$select=id").get("id")
            except GraphError as error:
                if error.code!=404: raise
        skipped={known.get(name) for name in ("deleteditems","junkemail","drafts","outbox")}
        short={normalise_name(str(v["name"]).split(" ",1)[-1]):v["id"] for v in vessels}
        found=[]
        def walk(url, parent, included):
            for page in self._pages(url+"?$top=100&$select=id,displayName,childFolderCount"):
                for folder in page.get("value",[]):
                    if folder["id"] in skipped: continue
                    name=str(folder.get("displayName") or ""); path=f"{parent}/{name}" if parent else name
                    is_inbox=folder["id"]==known.get("inbox"); standard=is_inbox or folder["id"]==known.get("sentitems")
                    match=identify_vessel(name,vessels); vessel=short.get(normalise_name(name),match.vessel_id)
                    if tracked is not None and not standard and vessel is not None and vessel not in tracked: continue
                    keep=not standard and (included or vessel is not None or match.match_type!="NO_MATCH")
                    if keep: found.append((folder["id"],path))
                    if folder.get("childFolderCount"):
                        walk(f"{GRAPH_MAIL}/mailFolders/{urllib.parse.quote(folder['id'],safe='')}/childFolders",path,keep or is_inbox)
        walk(f"{GRAPH_MAIL}/mailFolders","",False)
        return found

    def _delta_pages(self, folder, delta_link):
        query=f"{GRAPH_MAIL}/mailFolders/{urllib.parse.quote(folder,safe='')}/messages/delta?"+urllib.parse.urlencode({"$select":"id,internetMessageId,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,hasAttachments"})
        try: yield from self._pages(delta_link or query)
        except GraphError as error:
            if error.code!=410 or not delta_link: raise
            yield from self._pages(query)  # the saved position expired: read the folder again; stored emails are skipped

    def sync(self, repository, prompt=None, interactive=True):
        """Read headers, then the body of each new email that has a GC number in its subject and is not before the start date.

        Emails whose subject names a vessel that is not tracked are left out; an unclear vessel is kept for review.
        The start date is applied here: Graph returns at most 5,000 messages when a delta query is filtered by date.
        """
        self._token=self.acquire_token(prompt) if interactive else self.acquire_token(interactive=False)
        tracked=repository.tracked_vessel_ids(); vessels=repository.vessels()
        start=str(repository.settings().get("graph_start_date") or "")
        profile=self._get(f"{GRAPH_MAIL}?$select=mail,userPrincipalName")
        mine={str(profile.get(key)).casefold() for key in ("mail","userPrincipalName") if profile.get(key)}
        # Sent Items first: an email copied to oneself is in both folders and must be kept as outgoing.
        folders=[("sentitems","sentitems","Sent Items"),("inbox","inbox","Inbox")]
        folders+=[(folder_id,"folder:"+folder_id,path) for folder_id,path in self._other_folders(vessels,tracked)]
        result={"added":0,"folders":{}}
        for folder,state_key,label in folders:
            count=0; delta=None
            for page in self._delta_pages(folder,repository.delta_state(state_key).get("delta_link")):
                for item in page.get("value",[]):
                    if "@removed" in item: continue
                    count+=1
                    when=item.get("receivedDateTime") or item.get("sentDateTime") or ""
                    if when[:10]<start or not extract_gc_numbers(item.get("subject") or ""): continue
                    if tracked is not None and repository.match_vessel(item.get("subject") or "",vessels).vessel_id not in tracked|{None}: continue
                    from_value=(item.get("from") or {}).get("emailAddress",{})
                    recipients=[x.get("emailAddress",{}) for x in (item.get("toRecipients") or [])+(item.get("ccRecipients") or [])]
                    outgoing=folder=="sentitems" or str(from_value.get("address") or "").casefold() in mine
                    message={"id":item.get("id"),"graph_immutable_id":item.get("id"),"internet_message_id":item.get("internetMessageId"),"conversation_id":item.get("conversationId"),"mailbox_folder":label,"direction":"OUTGOING" if outgoing else "INCOMING","subject":item.get("subject") or "","sender_name":from_value.get("name"),"sender_address":from_value.get("address"),"recipients":recipients,"message_datetime":when,"has_attachments":item.get("hasAttachments"),"source":"graph"}
                    if repository.has_email(message): continue
                    try: body=self._get(f"{GRAPH_MAIL}/messages/{urllib.parse.quote(str(item.get('id')),safe='')}?$select=body,bodyPreview")
                    except GraphError as error:
                        if error.code==404: continue  # deleted since it was listed
                        raise
                    message["body"]=(body.get("body") or {}).get("content") or body.get("bodyPreview") or ""
                    if not repository.import_message(message).get("duplicate"): result["added"]+=1
                delta=page.get("@odata.deltaLink") or delta
            # If the tracked vessels were changed meanwhile, the folder must be read again with the new list.
            if repository.tracked_vessel_ids()==tracked: repository.save_delta_state(state_key,delta,count)
            if folder in ("inbox","sentitems"): result[folder]=count
            else: result["folders"][label]=count
        return result

    def disconnect(self):
        self._app=None
        if self.token_cache:
            path=Path(self.token_cache)
            if path.is_file(): path.unlink()
