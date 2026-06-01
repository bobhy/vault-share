/**
 * Compute the SHA-256 hex digest of an ArrayBuffer using the Web Crypto API.
 * Available on all platforms including Obsidian mobile — no Node.js required.
 */
export async function sha256Hex(content: ArrayBuffer): Promise<string> {
	const hashBuffer = await crypto.subtle.digest('SHA-256', content);
	return Array.from(new Uint8Array(hashBuffer))
		.map(b => b.toString(16).padStart(2, '0'))
		.join('');
}
