# Enhancement design -- authenticated access to cloud storage
This enhancement should provide an abstraction of Google Drive API and Oauth2 authentication and an implementation specific to Google Drive.

Peer projects [obsidian-smartsync-auth](../obsidian-smartsync-auth) and [obsidian-air-sync](../obsidian-air-sync) provide a pattern we can reuse in this project.

## Deliverables
### Cloud storage via Google Drive

A module containing one or more classes to interact with Google Drive.

The plugin currently targets Google Drive, but might in the future be extended to support MSFT OneDrive or DropBox.
For now, we won't implement an abstract interface because we don't know the proper abstractions.  When we choose to support another cloud storage provider, we'll design that abstraction and implement it for each provider.

#### CRUD on cloud folders and files.  
Allows the plugin to create, delete, read and write both folders and files in Google Drive.

- Read and write whole files: don't depend on any partial read or collaborative update capabilities that Google Drive may have.
- Handle both plain text (most common, usually Markdown) and binary blobs.  File content is typed as `string | Uint8Array`; callers are responsible for encoding/decoding.
- Signals errors by rejecting with a typed error class (e.g. `CloudStorageError`) that carries an error code (`not-found`, `auth-expired`, `quota-exceeded`, `network`, etc.).  Callers must not assume errors are plain `Error` instances.

#### Auth Relay
Authenticates via OAuth 2.0 authorization code flow.  A relay server holds the `client_secret` and performs the server-side token exchange so the secret is never embedded in the plugin.

Technique is based on [smart-sync-auth](../../smart-sync-auth), which is a Cloudflare Worker.  The vault-share relay lives in the `google-auth-relay/` directory of this repo and is deployed independently as its own Cloudflare Worker.

**Why not GitHub Pages:** GitHub Pages is static hosting only and cannot run server-side code or hold secrets.  The relay must execute a POST to Google's token endpoint using `client_secret`, which requires a server runtime.

**Why Cloudflare Workers:** No personal domain or paid hosting required.  Every worker gets a free `<worker-name>.<account>.workers.dev` subdomain.  A custom domain can be added later if desired.

**Relay endpoints** (mirrors smart-sync-auth):
- `GET /google/callback` — receives Google's OAuth redirect, exchanges auth code for tokens using `client_secret`, redirects browser to `obsidian://vault-share-auth?access_token=...&refresh_token=...&expires_in=...`
- `POST /google/token/refresh` — accepts `{ refresh_token }` in request body, returns a fresh `{ access_token, expires_in }` from Google without user interaction

**Relay configuration** (`wrangler.toml`, safe to commit):
- `GOOGLE_CLIENT_ID` — public OAuth2 client ID
- `GOOGLE_REDIRECT_URI` — `https://<worker-url>/google/callback`

**Relay secret** (provisioned once, never committed):

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

**State validation:** The relay validates an OAuth `state` parameter (base64-encoded JSON with `app` and `nonce` fields) before completing the exchange, rejecting unknown app IDs.

#### Credential handling

**OAuth2 scope:** `https://www.googleapis.com/auth/drive.file`
This scope grants access only to files and folders the plugin itself creates, which is appropriate for vault-share.  Note: when listing a folder's contents, only files created via this plugin's OAuth credential are visible — files placed there by other means (other apps, manual upload) will not appear.  The plugin settings already document this constraint ("If an existing folder is specified, it must have been created by some app using the same OAuth2 credential").

**Client ID:** Hardcoded as a constant in plugin source (safe to commit — the secret never leaves the relay).  Pattern from peer project:

```typescript
const GOOGLE_CLIENT_ID = "...apps.googleusercontent.com";
const RELAY_URL = "https://<worker-name>.<account>.workers.dev";
```

**Client secret:** Stored exclusively in the Cloudflare Worker secret store.  Never in plugin source, `.env` files, or `wrangler.toml`.

**OAuth flow (desktop):**
1. Plugin generates a random `nonce` and encodes `{ app: "vault-share", nonce }` as base64 `state`.
2. Plugin opens system browser to Google's authorization URL with `client_id`, `scope`, `state`, and `redirect_uri` pointing to the relay's `/google/callback`.
3. User consents in browser; Google redirects to relay with `code` and `state`.
4. Relay validates `state`, exchanges `code` + `client_secret` for tokens, redirects browser to `obsidian://vault-share-auth?access_token=...&refresh_token=...&state=...` (relay echoes `state` back).
5. Obsidian handles the custom URI; plugin decodes `state`, verifies the `nonce` matches what it generated in step 1 (rejecting the callback if not), then stores both tokens in `app.secretStorage`.

**Token storage:** `app.secretStorage` (Obsidian API, backed by OS keychain on desktop).  Keys: `vault-share-access-token`, `vault-share-refresh-token`, `vault-share-token-expiry` (ISO timestamp string).

**Token refresh:** The plugin tracks the access token expiry as an absolute timestamp derived from `expires_in` at the time tokens are stored or refreshed.  Before each Drive API call, the plugin checks whether the access token is within a short proactive window of expiry (e.g. 60 seconds); if so, it POSTs the refresh token to the relay's `/google/token/refresh` endpoint, stores the new access token and updated expiry, then proceeds with the API call.  No user interaction required.

**Dev setup procedure:** Provide a `docs/dev-setup-oauth.md` describing how to create a Google Cloud project, enable Drive API, create an OAuth2 web application credential, and provision the `client_secret` to the Cloudflare Worker.

### Plugin Settings
- in settings, 
    - a field to specify an arbitrary Drive folder path.  Normal case is this folder will be created by the plugin, and it will therefore have access.
    If an existing folder is specified, it must have been created by some app using the same OAuth2 credential in the past, so plugin should still have access.
    **Folder path format:** slash-separated folder names (forward or backward slash accepted), must begin with a separator.  The root is the provider's top-level personal folder: `My Drive` for Google Drive, `My files` for MSFT OneDrive; Dropbox natively uses forward-slash paths with the same convention.  Example: `/vault-share/shared`.  The plugin resolves the path to a provider file ID at connect time by walking the hierarchy, creating any missing segments.
    - a toggle button that alternates between "Connect" and "Disconnect" states:
        - **Connect:** initiates the OAuth flow, resolves the folder path to a Drive file ID, and confirms read/write access.  The file ID is retained for the duration of the connection.  On success the button label changes to "Disconnect".
        - **Disconnect:** revokes the stored tokens via Google's revocation endpoint, clears all token entries from `app.secretStorage`, and resets the button label to "Connect".

### interactive playground - Google Drive
These commands and dialogs demonstrate cloud storage access, but will not be included in the actual release of the plug in.
- persistent playground vault: path `persistentTestResources/playground-googleDrive`, is reused across runs.
- invoked by NPM scripts of pattern: `npm run playground:...`.
- `npm run playground:googleDrive:read`
    Reads cloud storage file to specified note in test vault
    - opens "Read File" dialog
        - "Drive folder": read only.  Shows the currently configured drive folder path in settings.
        - "Drive file" field, a select box populated with all the files present in the selected Drive folder.
        - "note to write" field, user enters the name of an Obsidian note to create with contents from the file selected above.
            If the named note exists, it is overwritten with the contents of the Drive file.
        - "Submit" and "Cancel" buttons: Submit actually reads the drive file and writes the note, displaying any error message that occurs.
- `npm run playground:googleDrive:write`
    Writes cloud storage file from specified note in test vault
    - "Drive folder": read only.  Shows the currently configured drive folder path in settings.
    - "Note to read" field, select box populated with all the notes present in the test vault
    - "Drive file" field, user enters name of cloud file to create or overwrite.
        If drive file doesn't currently exist, it is created.  Otherwise, it is overwritten.
    - "Submit" and "Cancel" buttons: Submit actually reads the note and writes the drive file, displaying any error message that occurs.

### End-to-end tests
- Suitable for Github CI
- Runs headless and unattended
- Test scenario:
    - Authenticate using a pre-stored refresh token (no browser interaction)
    - Create or reuse existing test folder named `vault-share-test-folder`
    - Write a file with ~1000 bytes of known content, verify it can be read back correctly

**CI credential provisioning:**  
The one-time setup command `npm run setup:e2e:wdio` opens a browser OAuth flow, obtains a refresh token, and saves it to `.e2e-refresh-token` (gitignored).  The dev then copies that same token value into the GitHub Actions secret `VAULT_SHARE_REFRESH_TOKEN` — there is no separate CI auth flow.  The e2e test harness reads `process.env.VAULT_SHARE_REFRESH_TOKEN` and falls back to `.e2e-refresh-token` for local execution.

**WARNING — use a dedicated test Google account, never a personal one.**  
The `drive.file` scope grants access to every Drive file vault-share has ever created for that account — not just files written during test runs.  If the developer uses their personal Google account, the CI refresh token exposes all their personal vault sync folders.  The setup command must be run while signed in to a throwaway Google account created solely for this purpose, with no personal data on its Drive.

### Documentation
Add a section in [ARCHITECTURE.md](./ARCHITECTURE.md) describing the Google Drive module: its classes, the OAuth flow, and the relay's role.
Provide TypeDoc in the source files describing the public interfaces of exported classes.