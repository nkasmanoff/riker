#!/usr/bin/env node
// Download the opencode CLI binary for a target platform/arch and place it in
// extensions/opencode-agent/bin/ so it gets bundled into the packaged app.
//
// Run this BEFORE the gulp packaging task (e.g. `npm run gulp vscode-darwin-arm64-min`),
// because the built-in extension is copied into the app verbatim by vsce.listFiles.
//
// Usage:
//   node extensions/opencode-agent/scripts/download-opencode.mjs            # host platform/arch
//   node extensions/opencode-agent/scripts/download-opencode.mjs --platform darwin --arch arm64
//   OPENCODE_VERSION=1.17.4 node extensions/opencode-agent/scripts/download-opencode.mjs
//
// Asset layout mirrors opencode's own installer (https://opencode.ai/install):
//   https://github.com/anomalyco/opencode/releases/download/v<version>/opencode-<os>-<arch>.(zip|tar.gz)
// and each archive contains a single `opencode` (or `opencode.exe`) binary.

import { createWriteStream, existsSync, mkdirSync, chmodSync, rmSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { get } from 'node:https';

// Version we vendor by default. Keep in sync with the range the integration is
// tested against (see extensions/opencode-agent/TODO.md).
const DEFAULT_VERSION = '1.17.4';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binDir = join(__dirname, '..', 'bin');

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--platform') { out.platform = argv[++i]; }
		else if (a === '--arch') { out.arch = argv[++i]; }
		else if (a === '--version') { out.version = argv[++i]; }
		else if (a === '--force') { out.force = true; }
	}
	return out;
}

// Map Node's platform/arch naming to opencode's release asset naming.
function targetFor(platform, arch) {
	const os = platform === 'win32' ? 'windows' : platform; // darwin | linux | windows
	let a = arch;
	if (a === 'x86_64') { a = 'x64'; }
	if (a === 'aarch64') { a = 'arm64'; }
	const combo = `${os}-${a}`;
	const supported = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64'];
	if (!supported.includes(combo)) {
		throw new Error(`Unsupported opencode target: ${combo} (supported: ${supported.join(', ')})`);
	}
	const ext = os === 'linux' ? 'tar.gz' : 'zip';
	const exe = os === 'windows' ? 'opencode.exe' : 'opencode';
	return { os, arch: a, combo, ext, exe };
}

function download(url, dest) {
	return new Promise((resolve, reject) => {
		const file = createWriteStream(dest);
		const req = get(url, { headers: { 'User-Agent': 'riker-build' } }, (res) => {
			if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				file.close();
				rmSync(dest, { force: true });
				return resolve(download(res.headers.location, dest));
			}
			if (res.statusCode !== 200) {
				file.close();
				rmSync(dest, { force: true });
				return reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
			}
			res.pipe(file);
			file.on('finish', () => file.close(() => resolve()));
		});
		req.on('error', (err) => { file.close(); rmSync(dest, { force: true }); reject(err); });
	});
}

function extract(archive, ext, into) {
	if (ext === 'tar.gz') {
		execFileSync('tar', ['-xzf', archive, '-C', into], { stdio: 'inherit' });
		return;
	}
	// .zip — prefer unzip, fall back to bsdtar (macOS `tar` handles zips).
	try {
		execFileSync('unzip', ['-oq', archive, '-d', into], { stdio: 'inherit' });
	} catch {
		execFileSync('tar', ['-xf', archive, '-C', into], { stdio: 'inherit' });
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const platform = args.platform ?? process.platform;
	const arch = args.arch ?? process.arch;
	const version = (args.version ?? process.env.OPENCODE_VERSION ?? DEFAULT_VERSION).replace(/^v/, '');
	const { combo, ext, exe } = targetFor(platform, arch);

	const finalPath = join(binDir, exe);
	if (existsSync(finalPath) && !args.force) {
		console.log(`opencode already present at ${finalPath} (use --force to re-download)`);
		return;
	}

	const filename = `opencode-${combo}.${ext}`;
	const url = `https://github.com/anomalyco/opencode/releases/download/v${version}/${filename}`;

	const work = join(tmpdir(), `opencode-dl-${process.pid}`);
	rmSync(work, { recursive: true, force: true });
	mkdirSync(work, { recursive: true });
	mkdirSync(binDir, { recursive: true });

	const archivePath = join(work, filename);
	console.log(`Downloading ${url}`);
	await download(url, archivePath);

	console.log(`Extracting ${filename}`);
	extract(archivePath, ext, work);

	const extracted = join(work, exe);
	if (!existsSync(extracted)) {
		throw new Error(`Archive did not contain ${exe}`);
	}
	rmSync(finalPath, { force: true });
	renameSync(extracted, finalPath);
	if (platform !== 'win32') {
		chmodSync(finalPath, 0o755);
	}
	rmSync(work, { recursive: true, force: true });

	console.log(`opencode ${version} (${combo}) -> ${finalPath}`);
}

main().catch((err) => {
	console.error(err.message || err);
	process.exit(1);
});
