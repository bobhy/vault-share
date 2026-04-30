const baseStyle = `
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 480px;
    margin: 80px auto;
    padding: 0 20px;
    color: #333;
    text-align: center;
  }
  h1 { font-size: 1.4rem; }
  .message { margin: 24px 0; line-height: 1.6; }
  .error { color: #c0392b; }
  a {
    display: inline-block;
    margin-top: 16px;
    padding: 10px 24px;
    background: #7c3aed;
    color: #fff;
    text-decoration: none;
    border-radius: 6px;
  }
  a:hover { background: #6d28d9; }
  .fallback { margin-top: 32px; font-size: 0.85rem; color: #666; }
`;

export function redirectPage(callbackUri: string, appName: string): string {
	const safeAppName = escapeHtml(appName);
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
  <title> Vault Share - OAuth redirect</title>
  <style>${baseStyle}</style>
</head>
<body>
  <h1> Vault Share</h1>
  <p class="message">Redirecting to ${safeAppName}&hellip;</p>
  <div class="fallback">
    <p>If it doesn't open automatically, click the button below.</p>
    <a href="${escapeHtml(callbackUri)}">Open ${safeAppName}</a>
  </div>
  <script>window.location.href = ${JSON.stringify(callbackUri)};</script>
</body>
</html>`;
}

export function errorPage(message: string): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <title> Vault Share - Error</title>
  <style>${baseStyle}</style>
</head>
<body>
  <h1> Vault Share</h1>
  <p class="message error">${escapeHtml(message)}<br>Please try connecting again from Obsidian.</p>
</body>
</html>`;
}

const docStyle = `
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    max-width: 720px;
    margin: 40px auto;
    padding: 0 20px 60px;
    color: #333;
    line-height: 1.7;
  }
  h1 { font-size: 1.6rem; margin-bottom: 4px; }
  h2 { font-size: 1.2rem; margin-top: 32px; }
  .subtitle { color: #666; font-size: 0.9rem; margin-bottom: 32px; }
  ul { padding-left: 20px; }
  li { margin-bottom: 6px; }
  a { color: #7c3aed; }
  a:hover { color: #6d28d9; }
  .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #e5e5e5; font-size: 0.85rem; color: #666; }
`;

export function privacyPage(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <title>Privacy Policy —  Vault Share for Obsidian</title>
  <style>${docStyle}</style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p class="subtitle">Last updated: April 30, 2026</p>

  <p>This Privacy Policy describes how <strong>Vault Share for Obsidian</strong> ("Vault Share", "the Plugin") handles your information. Vault Share is an open-source Obsidian community plugin developed by Bob Hyman ("we", "us").</p>

  <h2>1. What the plugin does</h2>
  <p>Vault Share provides multi-vault synchronization between local <a href="https://obsidian.md">Obsidian</a> vaults using a shared folder in your Google Drive account. The plugin runs entirely within the Obsidian application on your device.</p>

  <h2>2. Information we collect</h2>
  <p><strong>We do not collect, transmit, or store any of your personal data on our servers.</strong></p>
  <p>Vault Share operates locally on your device. The only network communication the plugin performs is directly between your device and Google's APIs. Specifically:</p>
  <ul>
    <li><strong>Google account information:</strong> When you authorize the plugin, Google provides an OAuth 2.0 authorization code. The OAuth relay server exchanges this code for access and refresh tokens, which are then passed directly to the plugin and stored locally on your device in Obsidian's SecretStorage (device keychain).</li>
    <li><strong>Google Drive file data:</strong> The plugin reads and writes files under a single designated folder in your Google Drive to perform synchronization. File content is transferred directly between your device and Google Drive over HTTPS.</li>
  </ul>
  <p>We operate a lightweight OAuth relay server hosted on Cloudflare Workers. This server performs the OAuth token exchange on your behalf — it receives a temporary authorization code from Google, exchanges it for access and refresh tokens using the securely stored client secret, and immediately passes those tokens to Obsidian via a custom URI scheme redirect. The server does not log, store, or persist any tokens or user data. All processing is transient and stateless.</p>

  <h2>3. How your information is used</h2>
  <p>All data processing occurs locally on your device. The plugin uses your Google Drive access to:</p>
  <ul>
    <li>List files under your designated sync folder</li>
    <li>Download files from the sync folder to your local vault</li>
    <li>Upload local files to your Google Drive folder</li>
    <li>Delete or rename files to reflect changes made locally or remotely</li>
  </ul>

  <h2>4. Data stored on your device</h2>
  <p>The following information is stored locally on your device:</p>
  <ul>
    <li><strong>OAuth tokens</strong> (access token and refresh token) — stored in Obsidian's SecretStorage (device keychain)</li>
    <li><strong>Plugin settings</strong> (sync folder path) — stored in Obsidian plugin data</li>
  </ul>
  <p>No data is stored on any external server controlled by us.</p>

  <h2>5. Google API Services — Limited Use Disclosure</h2>
  <p>Vault Share's use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
  <p>The plugin requests the <code>https://www.googleapis.com/auth/drive.file</code> scope. This scope grants access only to files and folders that the plugin itself creates — it cannot access any other files in your Google Drive. The plugin does not access files outside of the folder structure you designate for synchronization.</p>

  <h2>6. Third-party services</h2>
  <p>The plugin communicates exclusively with the following third-party services:</p>
  <ul>
    <li><strong>Google OAuth 2.0</strong> (<code>accounts.google.com</code>) — for authentication</li>
    <li><strong>Google Drive API v3</strong> (<code>www.googleapis.com</code>) — for file synchronization</li>
  </ul>
  <p>We do not use any analytics, advertising, or tracking services. We do not share your data with any third party.</p>

  <h2>7. Data retention and deletion</h2>
  <p>Since all data is stored locally on your device:</p>
  <ul>
    <li><strong>To revoke access:</strong> Click "Disconnect" in the plugin settings, or revoke access from your <a href="https://myaccount.google.com/permissions">Google Account permissions page</a>.</li>
    <li><strong>To delete local data:</strong> Uninstall the plugin from Obsidian. This removes plugin settings and the locally stored tokens from the device keychain.</li>
    <li><strong>Google Drive data:</strong> Files stored in your Google Drive remain under your full control and are not modified or deleted by the plugin once synchronization is disconnected.</li>
  </ul>

  <h2>8. Security</h2>
  <p>The plugin uses industry-standard security practices:</p>
  <ul>
    <li>OAuth 2.0 authorization code flow with server-side token exchange via relay</li>
    <li>CSRF protection via a cryptographically random nonce in the OAuth state parameter</li>
    <li>All communication with Google APIs is over HTTPS</li>
    <li>Access tokens are short-lived and automatically refreshed</li>
    <li>The OAuth relay server (Cloudflare Workers) processes tokens transiently and does not log or persist any data</li>
    <li>No credentials or tokens are stored on any server other than your local device keychain</li>
  </ul>

  <h2>9. Children's privacy</h2>
  <p> Vault Share is not directed at children under the age of 13. We do not knowingly collect personal information from children.</p>

  <h2>10. Open source</h2>
  <p>Vault Share is open-source software licensed under the MIT License. You can review the complete source code, including the OAuth relay, at <a href="https://github.com/bobhy/vault-share">github.com/bobhy/vault-share</a>.</p>

  <h2>11. Changes to this policy</h2>
  <p>We may update this Privacy Policy from time to time. Changes will be posted on this page with an updated "Last updated" date. Continued use of the plugin after any changes constitutes acceptance of the updated policy.</p>

  <h2>12. Contact</h2>
  <p>If you have questions about this Privacy Policy, please open an issue on the <a href="https://github.com/bobhy/vault-share/issues">GitHub repository</a>.</p>

  <div class="footer">
    <p>&copy; 2026 Bob Hyman. Vault Share for Obsidian is open-source software under the MIT License.</p>
  </div>
</body>
</html>`;
}

export function termsPage(): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <title>Terms of Service —  Vault Share for Obsidian</title>
  <style>${docStyle}</style>
</head>
<body>
  <h1>Terms of Service</h1>
  <p class="subtitle">Last updated: April 30, 2026</p>

  <p>These Terms of Service ("Terms") govern your use of <strong> Vault Share for Obsidian</strong> (" Vault Share", "the Plugin"), an open-source Obsidian community plugin developed by Bob Hyman ("we", "us"). By installing or using the Plugin, you agree to these Terms.</p>

  <h2>1. Description of service</h2>
  <p> Vault Share provides multi-vault synchronization between local <a href="https://obsidian.md">Obsidian</a> vaults using a shared folder in your Google Drive account. The Plugin is provided free of charge as open-source software under the MIT License.</p>

  <h2>2. Eligibility</h2>
  <p>You must have a valid Google account and an installation of Obsidian to use the Plugin. You must be at least 13 years old (or the minimum age required in your jurisdiction) to use the Plugin.</p>

  <h2>3. Your responsibilities</h2>
  <p>When using  Vault Share, you agree to:</p>
  <ul>
    <li>Maintain regular backups of your Obsidian vault and important data</li>
    <li>Keep your Google account credentials secure</li>
    <li>Use the Plugin in compliance with Google's <a href="https://policies.google.com/terms">Terms of Service</a> and <a href="https://developers.google.com/terms/api-services-user-data-policy">API Services User Data Policy</a></li>
    <li>Not use the Plugin for any unlawful or prohibited purpose</li>
  </ul>

  <h2>4. Google Drive access</h2>
  <p>The Plugin requires access to your Google Drive to perform synchronization. By authorizing the Plugin, you grant it permission to read, create, modify, and delete files within your designated sync folder. The Plugin uses the restricted <code>drive.file</code> scope and cannot access any files it did not create. You may revoke this access at any time through your <a href="https://myaccount.google.com/permissions">Google Account permissions</a> or via the "Disconnect" button in plugin settings.</p>

  <h2>5. Data and privacy</h2>
  <p>Your use of the Plugin is also governed by our <a href="/privacy">Privacy Policy</a>, which describes how the Plugin handles your information. The Plugin does not collect or transmit your personal data to any server controlled by us.</p>

  <h2>6. Intellectual property</h2>
  <p> Vault Share is released under the <a href="https://opensource.org/licenses/MIT">MIT License</a>. You may use, copy, modify, and distribute the software in accordance with that license. The source code is available at <a href="https://github.com/bobhy/vault-share">github.com/bobhy/vault-share</a>.</p>

  <h2>7. Disclaimer of warranties</h2>
  <p><strong>The Plugin is provided "as is" and "as available", without warranty of any kind, express or implied, including but not limited to the warranties of merchantability, fitness for a particular purpose, and non-infringement.</strong></p>
  <p>We do not warrant that:</p>
  <ul>
    <li>The Plugin will meet your specific requirements</li>
    <li>The Plugin will be uninterrupted, timely, secure, or error-free</li>
    <li>The synchronization results will be accurate or reliable</li>
    <li>Any defects in the Plugin will be corrected</li>
  </ul>

  <h2>8. Limitation of liability</h2>
  <p><strong>To the maximum extent permitted by applicable law, we shall not be liable for any indirect, incidental, special, consequential, or punitive damages, including but not limited to loss of data, loss of profits, or damages arising from the use or inability to use the Plugin.</strong></p>
  <p>You acknowledge that file synchronization involves inherent risks, including potential data loss or corruption. You are solely responsible for maintaining backups of your data.</p>

  <h2>9. Modifications to the Plugin</h2>
  <p>We reserve the right to modify, update, or discontinue the Plugin at any time without prior notice. We are not obligated to provide support, maintenance, or updates.</p>

  <h2>10. Third-party services</h2>
  <p>The Plugin integrates with Google Drive and Google OAuth. Your use of these services is subject to Google's own terms and policies. We are not responsible for any changes, outages, or issues with Google's services.</p>

  <h2>11. Termination</h2>
  <p>You may stop using the Plugin at any time by uninstalling it from Obsidian and revoking Google Drive access. We may discontinue the Plugin or revoke relay server access at our discretion if you violate these Terms.</p>

  <h2>12. Changes to these terms</h2>
  <p>We may update these Terms from time to time. Changes will be posted on this page with an updated "Last updated" date. Continued use of the Plugin after any changes constitutes acceptance of the updated Terms.</p>

  <h2>13. Governing law</h2>
  <p>These Terms shall be governed by and construed in accordance with the laws of the United States, without regard to its conflict of law provisions.</p>

  <h2>14. Contact</h2>
  <p>If you have questions about these Terms, please open an issue on the <a href="https://github.com/bobhy/vault-share/issues">GitHub repository</a>.</p>

  <div class="footer">
    <p>&copy; 2026 Bob Hyman.  Vault Share for Obsidian is open-source software under the MIT License.</p>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
