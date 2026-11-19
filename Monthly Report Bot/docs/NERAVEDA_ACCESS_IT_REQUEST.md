# Request: Microsoft Entra app registration for NeraVeda sign-in

NeraVeda (the Fleet Intelligence Suite used by the technical team) is a desktop application that runs on each
user's Windows PC. We would like users to sign in with their **Goodwood Microsoft work account**, so that access
follows company accounts, MFA and leaver processes. An admin inside NeraVeda then decides which workspaces each
person can open.

The application only needs to know **who the user is**. It reads no mail, files or other Microsoft 365 data.

## Please create

| Setting | Value |
|---|---|
| Name | NeraVeda Desktop |
| Supported account types | Accounts in this organizational directory only (single tenant) |
| Platform | **Mobile and desktop applications** |
| Redirect URI | `http://localhost` |
| Redirect URI (optional, for Windows single sign-on later) | `ms-appx-web://Microsoft.AAD.BrokerPlugin/<application client id>` |
| Allow public client flows | **Yes** (lets a user sign in with a code when the browser cannot return to the PC) |
| API permissions | Microsoft Graph, **delegated `User.Read`** only, with admin consent granted |
| Client secret / certificate | **None** (public desktop client) |

### Recommended

- In **Enterprise applications → NeraVeda Desktop → Properties**, set **Assignment required = Yes**, and assign a
  group such as **NeraVeda Users**. Only assigned people can then sign in at all. This check runs in Microsoft's
  service, not on the PC.
- Apply the usual Conditional Access / MFA policies.

## Please send back

- **Directory (tenant) ID**
- **Application (client) ID**

Neither is a secret. They are entered once on each PC with NeraVeda's setup command.

## Three questions

1. Is the **device code flow** allowed by Conditional Access? It is used only as a fallback.
2. Is `login.microsoftonline.com` excluded from **Sophos HTTPS inspection**? If not, the sign-in may fail with a
   certificate error, and we would need to add a trust-store setting.
3. Are the office PCs **Entra-joined** or registered? (Joined PCs can later use silent Windows sign-in.)

## What NeraVeda does with the sign-in

- It reads the signed-in name and email (the `User.Read` profile) and checks them against NeraVeda's own access
  list.
- Tokens stay in a cache encrypted for the Windows user (DPAPI). They are never written to logs or sent anywhere
  except to Microsoft.
- No other Microsoft 365 data is accessed. The existing Guarantee Claim Manager Outlook sync is separate and
  optional (`Mail.Read`). It could reuse this registration if you prefer, but that is not part of this request.
