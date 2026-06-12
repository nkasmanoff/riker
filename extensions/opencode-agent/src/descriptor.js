'use strict';
// Build the opencode descriptor (models + modes).
// Ported from harness-ide/src/main/harness/descriptor.ts.
//
// Models are discovered dynamically from `opencode models` so the picker always
// reflects the providers/models the user actually has configured.

const { execFile } = require('child_process');
const { promisify } = require('util');
const { resolveOpencodeBin } = require('./resolveBin');

const execFileAsync = promisify(execFile);

let cached = null;

// Used only if `opencode models` cannot be run.
const FALLBACK_MODELS = [
	{ id: 'opencode/north-mini-code-free', label: 'north-mini-code-free', hint: 'opencode' },
	{ id: 'frontier/anthropic/claude-sonnet-4.6', label: 'claude-sonnet-4.6', hint: 'frontier/anthropic' }
];

function toModelInfo(id) {
	const segments = id.split('/');
	const label = segments[segments.length - 1];
	const hint = segments.slice(0, -1).join('/');
	return { id, label, hint };
}

function pickDefault(models) {
	const sonnet = models.find((m) => /anthropic\/.*sonnet/i.test(m.id));
	if (sonnet) {
		return sonnet.id;
	}
	const anthropic = models.find((m) => /anthropic/i.test(m.id));
	if (anthropic) {
		return anthropic.id;
	}
	const free = models.find((m) => /free/i.test(m.id));
	if (free) {
		return free.id;
	}
	return models[0]?.id ?? 'opencode/north-mini-code-free';
}

async function discoverModels() {
	try {
		const bin = await resolveOpencodeBin();
		const { stdout } = await execFileAsync(bin, ['models'], { timeout: 8000 });
		const ids = stdout
			.split('\n')
			.map((l) => l.trim())
			.filter((l) => l.includes('/'));
		if (ids.length === 0) {
			return FALLBACK_MODELS;
		}
		return ids.map(toModelInfo);
	} catch {
		return FALLBACK_MODELS;
	}
}

async function getOpencodeDescriptor() {
	if (cached) {
		return cached;
	}
	const models = await discoverModels();
	cached = {
		id: 'opencode',
		name: 'opencode',
		models,
		defaultModel: pickDefault(models),
		modes: [
			{ id: 'build', label: 'Build', hint: 'Full tools' },
			{ id: 'plan', label: 'Plan', hint: 'Read-only' }
		],
		defaultMode: 'build',
		supportsResume: true
	};
	return cached;
}

module.exports = { getOpencodeDescriptor };
