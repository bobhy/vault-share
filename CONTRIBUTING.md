# Contributing to Vault Share

## Table of contents

1. [Setting up a dev machine](#1-setting-up-a-dev-machine)
2. [npm scripts reference](#2-npm-scripts-reference)
3. [Creating a Google OAuth credential](#3-creating-a-google-oauth-credential)
4. [Bumping the version and cutting a release](#4-bumping-the-version-and-cutting-a-release)

---

## 1. Setting up a dev machine

### Prerequisites

| Tool | Notes |
|------|-------|
| Node.js (LTS) | The project targets the current LTS release. `nvm` or `fnm` are recommended. |
| Obsidian desktop | Required for manual testing and e2e tests. |
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

### E2e test setup (one-time)

The e2e tests drive a sandboxed Obsidian instance and need a real Google Drive refresh token. Do this once per machine after you have authenticated the plugin in a running Obsidian vault:

```bash
npm run setup:e2e:wdio
```

This reads the stored refresh token from Obsidian's SecretStorage and saves it to `.e2e-refresh-token` (gitignored). The e2e test runner injects it into the sandboxed vault at startup. 

Prerequisites:

- A Google account used only for testing and (probably) different from
your main account.  Whatever account you respond to the oauth prompt with will have read/write access to all the vault files for that user.  
- Obsidian is running with a vault that is already authenticated with the above Google account to Google Drive via Vault Share.
- The `obsidian` CLI helper is on your PATH (installed by `wdio-obsidian-service`).

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
| `npm run test:e2e:single` | Build then run the single-vault e2e test suite via WebdriverIO. |
| `npm run test:e2e:cross` | Build then run the two-vault cross-sync e2e test suite via WebdriverIO multiremote. |
| `npm run docs` | Generate TypeDoc API documentation into `docs/`. |
| `npm run version` | Propagate the version in `package.json` into `manifest.json` and `versions.json` (see [version bump](#4-bumping-the-version-and-cutting-a-release)). |
| `npm run new-credential` | Replace the Google OAuth credential (see [section 3](#3-creating-a-google-oauth-credential)). |

All PRs must pass `npm run lint && npm run build && npm test` before merging.

---

## 3. Creating a Google OAuth credential

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

## 4. Bumping the version and cutting a release

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
