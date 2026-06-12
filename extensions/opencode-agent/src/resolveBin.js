'use strict';
// Resolve the absolute path to the opencode CLI binary.
// Ported from harness-ide/src/main/harness/resolve-bin.ts.
//
// When VS Code is launched from the macOS GUI, process.env.PATH does not
// include the user's shell PATH (e.g. ~/.opencode/bin, Homebrew). We probe
// well-known locations, then fall back to a login-shell lookup.

const { existsSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');
const { execFile } = require('child_process');

const cache = new Map();

function loginShellLookup(name) {
	return new Promise((resolve) => {
		const shell = process.env.SHELL || '/bin/zsh';
		execFile(shell, ['-lc', `command -v ${name}`], { timeout: 5000 }, (err, stdout) => {
			if (err) {
				return resolve(null);
			}
			const path = String(stdout).trim().split('\n').pop()?.trim();
			resolve(path && existsSync(path) ? path : null);
		});
	});
}

async function resolveBin(name, candidates) {
	const cached = cache.get(name);
	if (cached) {
		return cached;
	}
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) {
			cache.set(name, candidate);
			return candidate;
		}
	}
	const viaShell = await loginShellLookup(name);
	const resolved = viaShell ?? name; // last resort: hope it's on PATH
	cache.set(name, resolved);
	return resolved;
}

function resolveOpencodeBin() {
	return resolveBin('opencode', [
		process.env.OPENCODE_CLI,
		join(homedir(), '.opencode/bin/opencode'),
		'/opt/homebrew/bin/opencode',
		'/usr/local/bin/opencode',
		'/usr/bin/opencode'
	]);
}

module.exports = { resolveBin, resolveOpencodeBin };
