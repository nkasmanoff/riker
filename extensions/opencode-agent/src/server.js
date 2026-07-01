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
const http = require('node:http');
const https = require('node:https');
const { resolveOpencodeBin } = require('./resolveBin');

// All REST/SSE traffic goes through node:http (not the global `fetch`).
//
// Why: the global `fetch` is backed by undici, which enforces a default
// `headersTimeout`/`bodyTimeout` of 300s. A single agent turn (the POST to
// `/session/:id/message`) routinely runs longer than that while the model
// thinks or a tool runs, and the `/event` SSE stream can sit idle for minutes
// between events — both of which trip undici's idle timers and surface as a
// bare "fetch failed". This is especially common when the user steps away and
// the display sleeps. node:http has no such body/headers idle timeout, so a
// quiet-but-alive connection is never killed.
//
// We keep a dedicated keep-alive agent so concurrent chats (multiple chat
// tabs/windows) each get their own long-lived sockets without contention.
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: Infinity });

/**
 * Issue an HTTP(S) request with NO idle timeout and return the raw
 * `IncomingMessage` once response headers arrive. Aborts cleanly when the
 * optional AbortSignal fires.
 *
 * @param {URL} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<import('node:http').IncomingMessage>}
 */
function httpRequest(url, { method = 'GET', headers, body, signal } = {}) {
	return new Promise((resolve, reject) => {
		if (signal && signal.aborted) {
			reject(new Error('aborted'));
			return;
		}
		const isHttps = url.protocol === 'https:';
		const transport = isHttps ? https : http;
		// Send an explicit Content-Length (avoids chunked transfer encoding) to
		// match the previous fetch-based behavior.
		const finalHeaders = { ...headers };
		if (body !== undefined && finalHeaders['Content-Length'] === undefined) {
			finalHeaders['Content-Length'] = Buffer.byteLength(body);
		}
		const req = transport.request({
			protocol: url.protocol,
			hostname: url.hostname,
			port: url.port,
			path: url.pathname + url.search,
			method,
			headers: finalHeaders,
			agent: isHttps ? httpsAgent : httpAgent,
			// 0 = no socket inactivity timeout. Long turns and idle SSE streams
			// must survive an indefinitely quiet connection.
			timeout: 0
		}, resolve);
		req.on('error', reject);
		if (signal) {
			const onAbort = () => { req.destroy(new Error('aborted')); };
			signal.addEventListener('abort', onAbort, { once: true });
			req.on('close', () => signal.removeEventListener('abort', onAbort));
		}
		if (body !== undefined) {
			req.write(body);
		}
		req.end();
	});
}

/** Read an entire `IncomingMessage` body to a UTF-8 string. */
function readBody(res) {
	return new Promise((resolve, reject) => {
		let data = '';
		res.setEncoding('utf8');
		res.on('data', (chunk) => { data += chunk; });
		res.on('end', () => resolve(data));
		res.on('error', reject);
	});
}

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
 * An optional `signal` aborts the in-flight request (e.g. on turn interrupt).
 */
async function api(baseUrl, method, path, { directory, body, signal } = {}) {
	const url = new URL(baseUrl + path);
	if (directory) {
		url.searchParams.set('directory', directory);
	}
	const res = await httpRequest(url, {
		method,
		headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined,
		signal
	});
	const text = await readBody(res);
	const status = res.statusCode ?? 0;
	if (status < 200 || status >= 300) {
		throw new Error(`opencode ${method} ${path} -> ${status}${text ? `: ${text.slice(0, 300)}` : ''}`);
	}
	const contentType = res.headers['content-type'] || '';
	if (contentType.includes('json')) {
		return text ? JSON.parse(text) : undefined;
	}
	return text;
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
	const res = await httpRequest(url, { signal });
	const status = res.statusCode ?? 0;
	if (status < 200 || status >= 300) {
		res.resume(); // drain so the socket can be reused/freed
		throw new Error(`opencode /event subscription failed: ${status}`);
	}

	// Stream events as they arrive. node:http keeps this socket open with no
	// inactivity timeout, so a long-quiet stream is never dropped from under us.
	res.setEncoding('utf8');
	let buf = '';
	res.on('data', (chunk) => {
		buf += chunk;
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
	});
	// Aborted or connection dropped; the driver handles turn teardown.
	res.on('error', () => { /* swallow: teardown happens via the turn lifecycle */ });
}

module.exports = { getServerUrl, disposeServer, api, subscribeEvents };
