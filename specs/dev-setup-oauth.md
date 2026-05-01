# Dev setup — Google OAuth2 credential and auth relay

This document describes the one-time steps needed before the plugin can authenticate with Google Drive.  There are two parts: creating the Google Cloud OAuth2 credential, and deploying the Cloudflare Worker relay that holds the client secret.

## Prerequisites

- A Google account (use a dedicated development account, **not** your personal account — see the [E2E test warning in the enhancement design](enhancement-cloud-storage.md))
- [Node.js](https://nodejs.org/) installed
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed and authenticated with a Cloudflare account:
  ```bash
  npm install -g wrangler
  wrangler login
  ```

---

## Part 1 — Create the Google Cloud OAuth2 credential

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a new project (or reuse an existing one).

2. Enable the **Google Drive API**:
   - In the left sidebar select **APIs & Services → Library**
   - Search for "Google Drive API" and click **Enable**

3. Configure the **OAuth consent screen**:
   - Go to **APIs & Services → OAuth consent screen**
   - Select **External** user type
   - Fill in required fields:
     - **App name**: Vault share
     - **User support email**: your email
     - **Developer contact email**: your email
   - Under **App domain**, fill in:
     - **Privacy policy URL**: `https://vault-share-auth.bob-hyman.workers.dev/privacy`
     - **Terms of service URL**: `https://vault-share-auth.bob-hyman.workers.dev/terms`
   - Click **Save and continue**

4. Add the required **scope**:
   - On the Scopes step click **Add or remove scopes**
   - Search for and add: `https://www.googleapis.com/auth/drive.file`
   - Click **Update**, then **Save and continue**

5. Add yourself (and any other test users) as **test users** while the app is in testing mode.  Click **Save and continue**.

6. Create the **OAuth2 credential**:
   - Go to **APIs & Services → Credentials**
   - Click **Create credentials → OAuth client ID**
   - Select **Web application** as the application type
   - Set **Name**: `vault-share-relay`
   - Under **Authorized redirect URIs** add:
     ```
     https://vault-share-auth.bob-hyman.workers.dev/google/callback
     ```
   - Click **Create**
   - Copy the **Client ID** and **Client Secret** — you will need both in Part 2

---

## Part 2 — Deploy the Cloudflare Worker relay

The relay source lives in `google-auth-relay/worker/`.

```bash
cd google-auth-relay/worker
npm install
```

### 2a — Set the public variables in `wrangler.toml`

Edit `wrangler.toml` and replace the placeholder values:

```toml
[vars]
GOOGLE_CLIENT_ID = "<paste Client ID from step 6>"
GOOGLE_REDIRECT_URI = "https://vault-share-auth.bob-hyman.workers.dev/google/callback"
```

### 2b — Store the client secret

The client secret is never committed to source control.  Set it once via Wrangler's encrypted secret store:

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
# Wrangler will prompt: paste the Client Secret from step 6
```

### 2c — Deploy

```bash
npm run deploy
# or: npx wrangler deploy
```

Wrangler prints the worker URL after deployment.  Confirm the relay is live:

```
curl https://vault-share-auth.bob-hyman.workers.dev/privacy
```

The privacy policy page should load.

---

## Part 3 — Update the plugin source

Edit [src/gdrive/auth.ts](../src/gdrive/auth.ts) and replace the two constants near the top:

```typescript
export const GOOGLE_CLIENT_ID = '<paste Client ID>';
export const RELAY_BASE_URL = 'https://vault-share-auth.bob-hyman.workers.dev';
```

Rebuild the plugin:

```bash
npm run build
```

---

## Part 4 — Set up E2E test credentials

The E2E tests need a pre-stored refresh token so they can authenticate without a browser.

**Important**: run this step while signed in to a **dedicated test Google account**, not your personal account.  The `drive.file` scope gives the CI token access to every file vault-share has ever created on that account.

1. Install the plugin into an Obsidian vault (copy `main.js`, `manifest.json`, `styles.css` to `<vault>/.obsidian/plugins/vault-share/`).
2. Open Obsidian, go to Settings → Vault share → Connect, and complete the OAuth flow with the test Google account.
3. Run the setup script to extract the refresh token:
   ```bash
   npm run setup:e2e:wdio
   ```
   This saves the token to `.e2e-refresh-token` (gitignored).
4. Add the same token as a GitHub Actions secret named `VAULT_SHARE_REFRESH_TOKEN` in the repository settings.

---

## Verifying the full flow

With the plugin built and installed:

1. Open Obsidian Settings → Vault share
2. Enter a Drive folder path (e.g. `/vault-share-test`)
3. Click **Connect** — your browser should open Google's consent screen
4. After authorizing, Obsidian should show "Google Drive connected."
5. The button should change to **Disconnect**

Run the unit tests to confirm nothing is broken:

```bash
npm run lint && npm run build && npm test
```

Run the E2E test (requires `.e2e-refresh-token` or `VAULT_SHARE_REFRESH_TOKEN` env var):

```bash
npm run test:e2e:single
```
