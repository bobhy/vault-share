#!/usr/bin/env node
/**
 * Inspect a running Obsidian instance over the Chrome DevTools Protocol.
 *
 * Obsidian is an Electron app; launch it with a DevTools port and this script
 * can read its renderer state and stream its console — handy for debugging the
 * plugin live (and for letting an AI coding agent observe the app while you
 * drive the UI). No dependencies: uses Node's built-in fetch + global
 * WebSocket (Node 22+).
 *
 * First, start Obsidian with the port (quit all instances first):
 *
 *     /path/to/obsidian --remote-debugging-port=9222
 *
 * Then:
 *
 *     # Evaluate an expression in the renderer and print the JSON result:
 *     npm run cdp:eval -- "app.plugins.plugins['vault-share'].candidateStore.getAll().length"
 *
 *     # Stream the [vault-share] console (reconnects across plugin/page reloads):
 *     npm run cdp:console
 *
 * The port defaults to 9222; override with OBSIDIAN_CDP_PORT.
 *
 * Useful renderer handles (vault-share):
 *   app.plugins.plugins['vault-share']        — the plugin instance
 *     .candidateStore                          — .getAll(), .getPendingCount(), .isPausedSync()
 *     .scheduler.deps.bulkSync                 — .run()
 *     .api / .driveFolderId                    — Drive helpers
 *   activeDocument.querySelector('.vault-share-…')  — read rendered UI state
 */

const PORT = process.env.OBSIDIAN_CDP_PORT ?? '9222';
const [cmd, ...rest] = process.argv.slice(2);

/** Find the main vault renderer target (a page on app://obsidian.md). */
async function findPageTarget() {
	const res = await fetch(`http://127.0.0.1:${PORT}/json`);
	const targets = await res.json();
	return targets.find(t => t.type === 'page' && (t.url || '').startsWith('app://obsidian.md'))
		?? targets.find(t => t.type === 'page');
}

/** Open a CDP WebSocket session with a small request/response + event API. */
function openSession(wsUrl) {
	const ws = new WebSocket(wsUrl);
	let nextId = 0;
	const pending = new Map();
	const ready = new Promise((resolve, reject) => {
		ws.addEventListener('open', () => resolve(), { once: true });
		ws.addEventListener('error', err => reject(err), { once: true });
	});
	ws.addEventListener('message', ev => {
		const msg = JSON.parse(ev.data);
		if (msg.id && pending.has(msg.id)) {
			pending.get(msg.id)(msg);
			pending.delete(msg.id);
		} else if (msg.method && ws.onCdpEvent) {
			ws.onCdpEvent(msg);
		}
	});
	const send = (method, params) => {
		const id = ++nextId;
		ws.send(JSON.stringify({ id, method, params }));
		return new Promise(resolve => pending.set(id, resolve));
	};
	return { ws, ready, send };
}

function renderArg(a) {
	if (a.value !== undefined) return String(a.value);
	if (a.description !== undefined) return a.description;
	if (a.preview) return JSON.stringify(a.preview);
	return a.type ?? '';
}

async function doEval(expr) {
	if (!expr) {
		console.error('usage: npm run cdp:eval -- "<js expression>"');
		process.exit(1);
	}
	const page = await findPageTarget();
	if (!page) {
		console.error(`No Obsidian page target on port ${PORT}. Is it running with --remote-debugging-port=${PORT}?`);
		process.exit(1);
	}
	const { ws, ready, send } = openSession(page.webSocketDebuggerUrl);
	await ready;
	await send('Runtime.enable');
	const r = await send('Runtime.evaluate', {
		expression: `(async () => { return (${expr}); })()`,
		awaitPromise: true,
		returnByValue: true,
	});
	ws.close();
	if (r.result?.exceptionDetails) {
		console.error('EXCEPTION:', JSON.stringify(r.result.exceptionDetails, null, 2));
		process.exit(2);
	}
	console.log(JSON.stringify(r.result?.result?.value ?? null, null, 2));
}

async function doConsole() {
	const handleEvent = msg => {
		const ts = new Date().toISOString().slice(11, 19);
		if (msg.method === 'Runtime.consoleAPICalled') {
			const { type, args } = msg.params;
			const line = args.map(renderArg).join(' ');
			if (line.includes('[vault-share]') || type === 'error' || type === 'warning') {
				process.stdout.write(`${ts} [${type}] ${line}\n`);
			}
		} else if (msg.method === 'Log.entryAdded') {
			process.stdout.write(`${ts} [log:${msg.params.entry.level}] ${msg.params.entry.text}\n`);
		}
	};

	// Reconnect across page/plugin reloads (e.g. Hot Reload re-enables).
	for (;;) {
		try {
			const page = await findPageTarget();
			if (!page) throw new Error('no page target');
			const { ws, ready, send } = openSession(page.webSocketDebuggerUrl);
			ws.onCdpEvent = handleEvent;
			await ready;
			await send('Runtime.enable');
			await send('Log.enable');
			process.stdout.write(`--- attached to "${page.title}" (port ${PORT}) ---\n`);
			await new Promise((_, reject) => {
				ws.addEventListener('close', () => reject(new Error('disconnected')), { once: true });
				ws.addEventListener('error', () => reject(new Error('socket error')), { once: true });
			});
		} catch (err) {
			process.stdout.write(`--- ${err.message}; retrying in 2 s (Obsidian up with --remote-debugging-port=${PORT}?) ---\n`);
			await new Promise(r => setTimeout(r, 2000));
		}
	}
}

switch (cmd) {
	case 'eval':
		await doEval(rest.join(' '));
		break;
	case 'console':
		await doConsole();
		break;
	default:
		console.error('usage: node scripts/obsidian-cdp.mjs <eval "<expr>" | console>');
		process.exit(1);
}
