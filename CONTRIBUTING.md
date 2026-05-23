# Contributing to Vault Share

## Table of contents

1. [Setting up a dev machine](#1-setting-up-a-dev-machine)
2. [npm scripts reference](#2-npm-scripts-reference)
3. [Continuous integration](#3-continuous-integration)
4. [Creating a Google OAuth credential](#4-creating-a-google-oauth-credential)
5. [Bumping the version and cutting a release](#5-bumping-the-version-and-cutting-a-release)

---

## 1. Setting up a dev machine

### Prerequisites

| Tool | Notes |
|------|-------|
| Node.js (LTS) | The project targets the current LTS release. `nvm` or `fnm` are recommended. |
| Obsidian desktop | Required for manual testing and e2e tests. |
| Obsidian CLI | Also required.  Must be invokable as `obsidian-cli` rather than the default `obsidian`. |
| `gh` CLI | Required for cutting GitHub releases. Install from <https://cli.github.com>. |

### Clone and install

```bash
git clone https://github.com/bobhy/vault-share.git
cd vault-share
npm install
```

### Point the build at a vault

The built plugin must be installed inside an Obsidian vault's plugin directory so you can test it live. Use `npm run deploy` to build and copy the plugin files into one or more vault directories:

```bash
npm run deploy -- ~/Documents/my-vault
# or multiple vaults at once:
npm run deploy -- ~/Documents/vault-a ~/Documents/vault-b
```

This creates (or updates) `<vault>/.obsidian/plugins/vault-share/` with `main.js`, `manifest.json`, and `styles.css`.  It also deletes `data.json`, clearing all settings and disconnecting

For active development you will typically run the watcher instead (see [npm scripts](#2-npm-scripts-reference)) and reload the plugin manually inside Obsidian via **Settings → Community plugins → Vault share → Reload**.

### E2e test setup

The `npm run test:e2e:*` tests need access to live Google Drive.
We currently have a kludge setup procedure which ends up providing a bare Google Drive refresh token that they can use.

Prerequisites:

- A Google account used only for testing and (best practice) different from your main account.  
This account will have read/write access to all the vault files created by any instance of the plugin using the same account
anywhere in that user's Google Drive.
- Obsidian and Obsidian CLI installed on the test (dev) machine.

Then:
1. Invoke Obsidian GUI 
2. Open a non-test vault (could be new and empty)
3. Install freshly built plugin
4. In plugin settings, click the login button, do the OAuth2 dance.
5. Leave GUI running
6. At a command prompt
   1. CWD to root of the project
   2. run `npm run setup:e2e:wdio`

This reads the stored refresh token from Obsidian's SecretStorage and saves it to local file `.e2e-refresh-token` (gitignored). 
Retain this file for the duration of your e2e tests.
The e2e test runner injects it into the sandboxed vault at startup. 
---

## 2. npm scripts reference

| Script | What it does |
|--------|--------------|
| `npm install` | Install all dependencies. |
| `npm run dev` | Start esbuild in watch mode. Rebuilds `main.js` on every save. |
| `npm run build` | Type-check with `tsc`, then produce a production `main.js`. |
| `npm run deploy -- <vault>` | Build and install artifacts into an Obsidian vault directory. |
| `npm run lint` | Run ESLint (including the `eslint-plugin-obsidianmd` rules). Always run before pushing. |
| `npm test` | Run unit tests with Vitest (single pass). |
| `npm run test:watch` | Run Vitest in watch mode. |
| `npm run setup:e2e:wdio` | One-time e2e setup — saves the GDrive refresh token for test injection (see above). |
| `npm run test:e2e:single` | Build then run the single-vault e2e test suite headlessly via WebdriverIO. |
| `npm run test:e2e:single:interactive` | Same, but uses the current `$DISPLAY` — useful for debugging test failures visually. |
| `npm run test:e2e:cross` | Build then run the two-vault cross-sync e2e test suite headlessly via WebdriverIO multiremote. |
| `npm run test:e2e:cross:interactive` | Same, but uses the current `$DISPLAY`. |
| `npm run docs` | Generate TypeDoc API documentation into `docs/`. |
| `npm run version` | Propagate the version in `package.json` into `manifest.json` and `versions.json` (see [version bump](#5-bumping-the-version-and-cutting-a-release)). |
| `npm run new-credential` | Replace the Google OAuth credential (see [section 4](#4-creating-a-google-oauth-credential)). |

All PRs must pass `npm run lint && npm run build && npm test` before merging.

---

## 3. Continuous integration

The workflow at `.github/workflows/e2e.yml` runs the single-vault e2e suite on every push to `main` and on manual dispatch. It uses a headless virtual display (Xvfb + herbstluftwm) and injects the Google Drive refresh token from a repository secret.

### Setting up the repository secret

The e2e tests need a valid Google Drive refresh token to authenticate. Store it once as a GitHub Actions secret:

1. Obtain the token by running `npm run setup:e2e:wdio` locally (see [Setting up a dev machine](#1-setting-up-a-dev-machine)). The token is saved to `.e2e-refresh-token` in the project root.
2. In the GitHub repository go to **Settings → Secrets and variables → Actions → New repository secret**.
3. Name the secret `VAULT_SHARE_REFRESH_TOKEN` and paste the token value from `.e2e-refresh-token`.

The workflow reads the secret via `${{ secrets.VAULT_SHARE_REFRESH_TOKEN }}` and passes it to the test runner as an environment variable. The `.e2e-refresh-token` file is gitignored and never committed.

### Token expiry

Google refresh tokens remain valid indefinitely as long as they are used regularly. However, if Google rotates the token (returning a new `refresh_token` in a token-refresh response), the stored secret becomes stale and the next CI run will fail with an authentication error. Fix it by re-running `npm run setup:e2e:wdio` locally and updating the repository secret with the new value.

### Running e2e tests locally

By default the e2e scripts run headlessly (Xvfb is started automatically by the wdio config). To run interactively against your current display — useful when debugging a failing test — use the `:interactive` variants:

```bash
npm run test:e2e:single:interactive
npm run test:e2e:cross:interactive
```

`npm run setup:e2e:wdio` always runs interactively; it connects to the running Obsidian desktop via `obsidian-cli` and does not support headless use.

---

## 4. Creating a Google OAuth credential

The plugin authenticates through a Cloudflare Worker relay (`google-auth-relay/worker`) that holds the OAuth client secret. When you need a new credential — because the existing one was rotated, revoked, or you are forking the project — follow these steps.

### Create the credential in Google Cloud Console

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and select (or create) your project.
2. Enable the **Google Drive API** for the project if it is not already enabled.
3. Navigate to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
4. Set application type to **Web application**.
5. Under **Authorized redirect URIs**, add the relay callback URL:
   ```text
   https://<your-worker-subdomain>.workers.dev/google/callback
   ```
   Replace `<your-worker-subdomain>` with your Cloudflare Worker URL. The current relay URL is in `src/gdrive/auth.ts` as `RELAY_BASE_URL`.
6. Click **Create**. Copy the **Client ID** and **Client secret** — you will need them in the next step.
7. On the **OAuth consent screen**, add the scope `https://www.googleapis.com/auth/drive.file`.
8. Add any test users you need while the app is in testing status.

### Install the new credential

Run the interactive script:

```bash
npm run new-credential
```

It will prompt for the client ID and client secret, then:

- Update `GOOGLE_CLIENT_ID` in `google-auth-relay/worker/wrangler.toml` and `src/gdrive/auth.ts`.
- Upload the client secret to Cloudflare Workers secret storage via `wrangler secret put`.
- Redeploy the worker via `wrangler deploy` so the new client ID takes effect immediately.

Prerequisites for this step:

- `wrangler` is authenticated to your Cloudflare account (`npx wrangler login`).
- You have permission to deploy the Worker in the Cloudflare project.

After the script completes, commit the two modified files:

```bash
git add google-auth-relay/worker/wrangler.toml src/gdrive/auth.ts
git commit -m "chore: install new Google OAuth credential"
```

The client secret is **never committed** — it lives only in Cloudflare's secret store.

---

## 5. Bumping the version and cutting a release

The version number lives in three files that must stay in sync: `package.json`, `manifest.json`, and `versions.json`. The `npm run version` script keeps them in sync automatically.

### Step-by-step

1. **Edit `package.json`** — change the `version` field to the new SemVer string (no `v` prefix).

2. **Run the version script:**
   ```bash
   npm run version
   ```
   This updates `manifest.json` and appends an entry to `versions.json` mapping the new version to the current `minAppVersion`. If you are also raising the minimum required Obsidian version, update `manifest.json`'s `minAppVersion` field *before* running this script.

3. **Update `CHANGES.md`** with a summary of what changed in this release.

4. **Commit and tag:**
   ```bash
   git add package.json CHANGES.md   # manifest.json and versions.json already staged by `npm run version`
   git commit -m "chore: release X.Y.Z"
   git tag X.Y.Z
   git push && git push --tags
   ```
   The tag must match the `package.json` version exactly — no `v` prefix.

5. **Create the GitHub release:**
   ```bash
   gh release create X.Y.Z \
     --title "X.Y.Z" \
     --notes-file <(sed -n '/^## \[X.Y.Z\]/,/^## /p' CHANGES.md | head -n -1)
   ```
   Or use the GitHub web UI: go to **Releases → Draft a new release**, select the tag you just pushed, paste the changelog section, and publish.

   The Obsidian community plugin registry monitors GitHub releases and picks up the new version automatically once the release is published.

### What each file contains

| File | Purpose |
|------|---------|
| `package.json` | Source of truth for the version. Edit this first. |
| `manifest.json` | Read by Obsidian to identify and load the plugin. Must match `package.json`. |
| `versions.json` | Maps each released version to the minimum Obsidian app version it requires. Used by the plugin registry for compatibility checks. |
