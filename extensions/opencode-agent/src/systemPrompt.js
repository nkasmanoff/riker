'use strict';
// Full-system-prompt document for the `/system` editor.
//
// opencode assembles each turn's system prompt as (LLMRequestPrep.prepare):
//   [ agent.prompt || built-in provider prompt,   <- BASE (replaceable)
//     environment block + instruction files,      <- generated fresh each turn
//     user.system ]                               <- EXTRAS (our setting)
//
// The editor document shows BASE and EXTRAS as editable sections delimited by
// marker lines. The built-in provider prompts ship inside the opencode binary
// and are not exposed over the API, so we vendor exact copies (pinned to the
// opencode version below) in prompts/builtin/ and replicate the selection
// logic from packages/opencode/src/session/system.ts.

const fs = require('fs');
const path = require('path');

const PINNED_VERSION = '1.17.4';
const BUILTIN_DIR = path.join(__dirname, '..', 'prompts', 'builtin');

const BASE_MARKER = '<!-- ======== BASE AGENT PROMPT (edits replace the built-in prompt) ======== -->';
const EXTRA_MARKER = '<!-- ======== EXTRA INSTRUCTIONS (appended after the base, every turn) ======== -->';

/**
 * Which built-in prompt a model gets. Port of `SystemPrompt.provider()`
 * (packages/opencode/src/session/system.ts @ v1.17.4), matched on the
 * model's `api.id`.
 */
function builtinPromptName(apiId) {
	const id = String(apiId || '');
	const low = id.toLowerCase();
	if (id.includes('gpt-4') || id.includes('o1') || id.includes('o3')) {
		return 'beast';
	}
	if (id.includes('gpt')) {
		return id.includes('codex') ? 'codex' : 'gpt';
	}
	if (id.includes('gemini-')) {
		return 'gemini';
	}
	if (id.includes('claude')) {
		return 'anthropic';
	}
	if (low.includes('trinity')) {
		return 'trinity';
	}
	if (low.includes('kimi')) {
		return 'kimi';
	}
	return 'default';
}

/** Vendored built-in prompt text, or null if missing. */
function loadBuiltinPrompt(name) {
	try {
		return fs.readFileSync(path.join(BUILTIN_DIR, `${name}.txt`), 'utf8');
	} catch {
		return null;
	}
}

/**
 * Render the editor document.
 * @param {{ baseLabel: string, baseText: string, extras: string }} parts
 */
function buildSystemPromptDoc({ baseLabel, baseText, extras }) {
	const header = [
		'<!--',
		'  opencode full system prompt — opened via /system. Save to apply.',
		'',
		`  Base prompt source: ${baseLabel}`,
		'',
		'  How saving works:',
		'  - Edit the BASE section to REPLACE the prompt the build agent runs with',
		'    (stored as an agent prompt override in this project\'s opencode config).',
		'  - Restore the BASE section to the built-in text exactly to clear the',
		'    override and fall back to opencode\'s default.',
		'  - The EXTRA section is appended after the base on every turn',
		'    (stored in the opencode.systemPrompt setting).',
		'',
		'  Not shown here: the environment block (cwd, platform, date), AGENTS.md',
		'  instruction files, and skill listings — opencode regenerates those',
		'  fresh on every turn, so they cannot be edited.',
		'',
		'  Do not edit the two section marker lines.',
		'-->'
	].join('\n');
	return [
		header,
		'',
		BASE_MARKER,
		'',
		baseText.trim(),
		'',
		EXTRA_MARKER,
		'',
		extras.trim(),
		''
	].join('\n');
}

/**
 * Parse an edited document back into its sections.
 * @returns {{ base: string, extras: string } | null} null if the markers were
 * removed, duplicated, or reordered.
 */
function parseSystemPromptDoc(text) {
	const baseIdx = text.indexOf(BASE_MARKER);
	const extraIdx = text.indexOf(EXTRA_MARKER);
	if (baseIdx === -1 || extraIdx === -1 || extraIdx < baseIdx) {
		return null;
	}
	if (text.indexOf(BASE_MARKER, baseIdx + 1) !== -1 || text.indexOf(EXTRA_MARKER, extraIdx + 1) !== -1) {
		return null;
	}
	const base = text.slice(baseIdx + BASE_MARKER.length, extraIdx).trim();
	const extras = text.slice(extraIdx + EXTRA_MARKER.length).trim();
	return { base, extras };
}

module.exports = {
	PINNED_VERSION,
	BASE_MARKER,
	EXTRA_MARKER,
	builtinPromptName,
	loadBuiltinPrompt,
	buildSystemPromptDoc,
	parseSystemPromptDoc
};
