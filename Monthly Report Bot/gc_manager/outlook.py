"""Read-only Outlook boundary and local fixture importer."""
from __future__ import annotations
import json
import os
from pathlib import Path
import re
from datetime import datetime
import urllib.error
import urllib.parse
import urllib.request

GRAPH_SCOPES = ("User.Read", "Mail.Read", "offline_access", "openid", "profile")
GRAPH_FORBIDDEN_SCOPES = ("Mail.ReadWrite", "Mail.Send")


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
    headers={"Prefer": 'IdType="ImmutableId"'}

    def __init__(self, client_id=None, tenant_id=None, token_cache=None):
        self.client_id=client_id
        self.tenant_id=tenant_id
        self.token_cache=token_cache
        self._app=None

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

    def acquire_token(self, prompt=None):
        app=self._load_app()
        accounts=app.get_accounts()
        result=app.acquire_token_silent(list(self.api_scopes),account=accounts[0]) if accounts else None
        if not result:
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
        try:
            with urllib.request.urlopen(request,timeout=45) as response: return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail=error.read().decode("utf-8","replace")[:1200]
            raise RuntimeError(f"Microsoft Graph returned HTTP {error.code}: {detail}") from error

    @property
    def configured(self):
        return bool(self.client_id and self.tenant_id)

    def sync(self, repository, prompt=None):
        token=self.acquire_token(prompt)
        result={}
        for folder in ("inbox","sentitems"):
            state=repository.delta_state(folder)
            query=("https://graph.microsoft.com/v1.0/me/mailFolders/"+folder+"/messages/delta?"+urllib.parse.urlencode({"$select":"id,internetMessageId,conversationId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,body,bodyPreview,hasAttachments"}))
            url=state.get("delta_link") or query
            count=0; delta=None
            while url:
                page=self._request(url,token)
                for item in page.get("value",[]):
                    if "@removed" in item: continue
                    from_value=item.get("from",{}).get("emailAddress",{})
                    recipients=[x.get("emailAddress",{}) for x in (item.get("toRecipients") or [])+(item.get("ccRecipients") or [])]
                    message={"id":item.get("id"),"graph_immutable_id":item.get("id"),"internet_message_id":item.get("internetMessageId"),"conversation_id":item.get("conversationId"),"mailbox_folder":"Inbox" if folder=="inbox" else "Sent Items","direction":"INCOMING" if folder=="inbox" else "OUTGOING","subject":item.get("subject") or "","sender_name":from_value.get("name"),"sender_address":from_value.get("address"),"recipients":recipients,"message_datetime":item.get("receivedDateTime") or item.get("sentDateTime"),"body":(item.get("body") or {}).get("content") or item.get("bodyPreview") or "","has_attachments":item.get("hasAttachments"),"source":"graph"}
                    repository.import_message(message); count+=1
                url=page.get("@odata.nextLink")
                delta=page.get("@odata.deltaLink") or delta
            repository.save_delta_state(folder,delta,count)
            result[folder]=count
        return result

    def disconnect(self):
        self._app=None
        if self.token_cache:
            path=Path(self.token_cache)
            if path.is_file(): path.unlink()
