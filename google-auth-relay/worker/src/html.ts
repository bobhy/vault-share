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
  <title>Vault share - OAuth redirect</title>
  <style>${baseStyle}</style>
</head>
<body>
  <h1>Vault share</h1>
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
  <title>Vault share - Error</title>
  <style>${baseStyle}</style>
</head>
<body>
  <h1>Vault share</h1>
  <p class="message error">${escapeHtml(message)}<br>Please try connecting again from Obsidian.</p>
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
