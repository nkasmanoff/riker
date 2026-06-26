'use strict';
// Resolve the absolute path to the opencode CLI binary.
// Ported from harness-ide/src/main/harness/resolve-bin.ts.
//
// When VS Code is launched from the macOS GUI, process.env.PATH does not
// include the user's shell PATH (e.g. ~/.opencode/bin, Homebrew). We prefer a
// binary bundled inside this extension (so the app works with no separate
// install), then probe well-known locations, then fall back to a login-shell
// lookup.

const { existsSync, chmodSync, statSync } = require('fs');
const { homedir } = require('os');
const { join } = require('path');
const { execFile } = require('child_process');

const cache = new Map();

// opencode binary bundled with the app, if present. Populated by
// scripts/download-opencode.mjs before packaging. On Windows it's a .exe.
function bundledOpencodeBin() {
	const exe = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
	const bundled = join(__dirname, '..', 'bin', exe);
	if (!existsSync(bundled)) {
		return undefined;
	}
	// File copying through the build pipeline can drop the executable bit.
	if (process.platform !== 'win32') {
		try {
			if ((statSync(bundled).mode & 0o111) === 0) {
				chmodSync(bundled, 0o755);
			}
		} catch {
			// best-effort; spawn will surface a clearer error if it's truly broken
		}
	}
	return bundled;
}

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
		// An explicit override always wins.
		process.env.OPENCODE_CLI,
		// Prefer the copy shipped inside the app over any system install so the
		// agent works out of the box and on a version we've tested against.
		bundledOpencodeBin(),
		join(homedir(), '.opencode/bin/opencode'),
		'/opt/homebrew/bin/opencode',
		'/usr/local/bin/opencode',
		'/usr/bin/opencode'
	]);
}

module.exports = { resolveBin, resolveOpencodeBin };
