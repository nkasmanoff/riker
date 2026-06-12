'use strict';
// Manages a single long-lived `opencode serve` process shared by all chat
// turns, plus small HTTP/SSE helpers for its REST API.
//
// Why a server instead of `opencode run --format json`: the run command only
// prints parts *after* they complete (`part.time?.end` gate in opencode's
// cli/cmd/run.ts) and drops reasoning parts entirely unless `--thinking` is
// set. The server's `/event` SSE stream emits `message.part.delta` events
// token-by-token for both text and reasoning — true streaming.

const { spawn } = require('child_process');
const { resolveOpencodeBin } = require('./resolveBin');

let serverPromise = null;
/** @type {import('child_process').ChildProcess | null} */
let serverProc = null;

function spawnServer() {
	return resolveOpencodeBin().then((bin) => new Promise((resolve, reject) => {
		// Port 0 lets the OS pick a free port; we parse it from the banner.
		const child = spawn(bin, ['serve', '--port', '0'], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env }
		});

		let banner = '';
		let settled = false;
		const onData = (chunk) => {
			if (settled) {
				return;
			}
			banner += chunk;
			const m = /listening on (http:\/\/[^\s]+)/.exec(banner);
			if (m) {
				settled = true;
				resolve({ url: m[1].replace(/\/+$/, ''), child });
			}
		};
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', onData);
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', onData);

		child.on('error', (err) => {
			if (!settled) {
				settled = true;
				reject(new Error(`Failed to launch opencode serve: ${err.message}`));
			}
		});
		child.on('exit', (code) => {
			if (!settled) {
				settled = true;
				reject(new Error(`opencode serve exited during startup (code ${code}): ${banner.slice(-400)}`));
			}
			if (serverProc === child) {
				serverProc = null;
				serverPromise = null;
			}
		});

		setTimeout(() => {
			if (!settled) {
				settled = true;
				try { child.kill('SIGTERM'); } catch { /* already gone */ }
				reject(new Error('Timed out waiting for opencode serve to start'));
			}
		}, 20000);
	}));
}

/** Returns the base URL of the shared opencode server, starting it if needed. */
function getServerUrl() {
	if (!serverPromise) {
		serverPromise = spawnServer().then(({ url, child }) => {
			serverProc = child;
			return url;
		}).catch((err) => {
			serverPromise = null;
			throw err;
		});
	}
	return serverPromise;
}

function disposeServer() {
	if (serverProc) {
		try { serverProc.kill('SIGTERM'); } catch { /* already gone */ }
		serverProc = null;
	}
	serverPromise = null;
}

/**
 * Call the opencode REST API. All session routes are scoped by the
 * `directory` query param (opencode keeps one instance per project dir).
 */
async function api(baseUrl, method, path, { directory, body } = {}) {
	const url = new URL(baseUrl + path);
	if (directory) {
		url.searchParams.set('directory', directory);
	}
	const res = await fetch(url, {
		method,
		headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`opencode ${method} ${path} -> ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`);
	}
	const contentType = res.headers.get('content-type') || '';
	return contentType.includes('json') ? res.json() : res.text();
}

/**
 * Subscribe to the server's SSE event stream for a project directory.
 * Resolves once the connection is established (events may then arrive at any
 * time). Abort via the provided AbortSignal.
 *
 * @param {string} baseUrl
 * @param {string} directory
 * @param {(event: any) => void} onEvent parsed JSON event payloads
 * @param {AbortSignal} signal
 */
async function subscribeEvents(baseUrl, directory, onEvent, signal) {
	const url = new URL(baseUrl + '/event');
	url.searchParams.set('directory', directory);
	const res = await fetch(url, { signal });
	if (!res.ok || !res.body) {
		throw new Error(`opencode /event subscription failed: ${res.status}`);
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	(async () => {
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}
				buf += decoder.decode(value, { stream: true });
				let idx;
				while ((idx = buf.indexOf('\n')) !== -1) {
					const line = buf.slice(0, idx).trim();
					buf = buf.slice(idx + 1);
					if (line.startsWith('data:')) {
						let event;
						try {
							event = JSON.parse(line.slice(5));
						} catch {
							continue;
						}
						onEvent(event);
					}
				}
			}
		} catch {
			// Aborted or connection dropped; the driver handles turn teardown.
		}
	})();
}

module.exports = { getServerUrl, disposeServer, api, subscribeEvents };
