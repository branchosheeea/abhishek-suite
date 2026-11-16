# Microsoft Graph setup for Guarantee Claim Manager

Graph is optional. The Suite and GC module work with Graph disabled and accept local JSON fixture imports. The module uses delegated read-only mail access and never writes to Outlook.

## Entra app registration

1. In the Microsoft Entra admin center, register a single-tenant or organization-approved application for the tenant that owns the mailbox.
2. Under **Authentication**, enable **Allow public client flows** for device-code authentication. No client secret is needed.
3. Add only delegated Microsoft Graph permissions: `User.Read` and `Mail.Read`. OpenID Connect uses `openid`, `profile`, and `offline_access` during delegated sign-in.
4. Request tenant admin consent if the organization's consent policy requires it.
5. Record the Application (client) ID and Directory (tenant) ID.
6. No redirect URI is used by the device-code flow in this implementation. If tenant policy requires an explicit public-client redirect, configure the standard native client redirect `http://localhost` and confirm it with the tenant administrator.

## Local configuration and first login

Set these environment variables for the Windows account that launches the Suite (copy the names from `.env.example`):

```text
AZURE_CLIENT_ID=<application client ID>
AZURE_TENANT_ID=<directory tenant ID>
GC_GRAPH_ENABLED=true
GC_GRAPH_SYNC_INTERVAL_MINUTES=5
GC_LOCAL_USER_NAME=<local operator name>
GC_VESSEL_AUTO_MATCH_THRESHOLD=90
GC_VESSEL_REVIEW_THRESHOLD=80
GC_VESSEL_MATCH_MARGIN=8
```

Install the project requirements, restart the Suite, open GC Manager, and choose **Sync Outlook Now**. Complete the device sign-in prompt with the intended mailbox. Sync reads Inbox and Sent Items separately. The local MSAL cache is protected by Windows DPAPI and stored under `%LOCALAPPDATA%\AbhishekAutomationSuite\credentials`. It is never returned to the UI or written to logs. **Disconnect Outlook** removes only this local cache; it does not change mailbox data.

## Permission verification

Before granting consent, verify the app has only `User.Read` and `Mail.Read` under Microsoft Graph delegated permissions. Verify that both `Mail.ReadWrite` and `Mail.Send` are absent. The adapter requests `User.Read` and `Mail.Read`; MSAL adds the standard `offline_access`, `openid`, and `profile` scopes itself. No mail-write or mail-send operation is implemented.

## Troubleshooting

- **Outlook Not Configured:** Graph is disabled or either client/tenant ID is missing. This is a valid local mode; use the mock importer.
- **Admin approval required:** ask the tenant administrator to review and consent to the listed read-only delegated permissions.
- **Invalid client / tenant:** confirm the IDs and tenant type match the app registration.
- **No browser/device flow:** enable public client flows and ensure the sign-in device can reach Microsoft identity endpoints.
- **Cache cannot be unlocked:** the cache is bound to the Windows user. Disconnect and sign in again as the intended Windows account.
- **Graph error:** sync state records the error by folder. Retry is safe because message import is idempotent and uses immutable message IDs.

## Smoke checklist

1. Start the existing Suite dashboard and open the GC Manager card.
2. With Graph disabled, confirm **Outlook Not Configured** appears and import either a local JSON fixture or an exported `.msg` archive. The `.msg` option requires classic Outlook and reads files locally; it does not modify Outlook.
3. Confirm an unseen vessel/GC subject creates a `NEW_GC` review item; resolve it by registering the claim.
4. Confirm the email appears in the claim timeline and daily attention, then reimport it and verify no duplicate appears.
5. With Entra configuration and consent, sign in and sync Inbox/Sent Items; verify last sync state and that no Outlook message was changed.
6. Confirm no Graph permission for `Mail.ReadWrite` or `Mail.Send` exists.
