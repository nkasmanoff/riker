'use strict';
// Ghost-text inline completions (Cursor-style Tab autocomplete).
//
// Copilot's completions are gone with Copilot removed; this registers an
// InlineCompletionItemProvider backed by a fill-in-the-middle (FIM) model
// server. It's deliberately backend-flexible because the local setup varies:
//   - `openai` mode  -> POST <endpoint> { prompt, suffix, max_tokens, ... }
//                        (OpenAI-compatible /v1/completions; `suffix` is the FIM
//                        field) -> choices[0].text
//   - `llama`  mode  -> POST <endpoint> { input_prefix, input_suffix, ... }
//                        (llama.cpp /infill) -> content
//
// Everything degrades gracefully: if the server is unreachable we back off so a
// missing model server never spams requests or adds keystroke latency. The pure
// request/parse/clean helpers are unit-tested; the provider glue is thin.

let vscode = null;
try { vscode = require('vscode'); } catch { /* tests */ }

const MAX_PREFIX_CHARS = 4000;
const MAX_SUFFIX_CHARS = 1000;
const MAX_COMPLETION_CHARS = 2000;
const REQUEST_TIMEOUT_MS = 2000;
const AUTOMATIC_DEBOUNCE_MS = 120;
const FAILURE_THRESHOLD = 3;
const BACKOFF_MS = 60000;

/** Whether completions are enabled for a given editor language. */
function isLanguageEnabled(languageId, disabledLanguages) {
	if (!Array.isArray(disabledLanguages) || disabledLanguages.length === 0) {
		return true;
	}
	const id = String(languageId || '').toLowerCase();
	return !disabledLanguages.some((d) => String(d || '').toLowerCase() === id);
}

/** Clamp the FIM context windows around the cursor. */
function clampContext(prefix, suffix, maxPrefix = MAX_PREFIX_CHARS, maxSuffix = MAX_SUFFIX_CHARS) {
	const p = typeof prefix === 'string' ? prefix : '';
	const s = typeof suffix === 'string' ? suffix : '';
	return {
		prefix: p.length > maxPrefix ? p.slice(p.length - maxPrefix) : p,
		suffix: s.length > maxSuffix ? s.slice(0, maxSuffix) : s
	};
}

/**
 * Build the request body for the configured backend.
 * @param {'openai' | 'llama'} api
 * @param {{ prefix: string, suffix: string, model?: string, maxTokens?: number, temperature?: number }} opts
 */
function buildRequestBody(api, opts) {
	const maxTokens = typeof opts.maxTokens === 'number' ? opts.maxTokens : 128;
	const temperature = typeof opts.temperature === 'number' ? opts.temperature : 0.2;
	if (api === 'llama') {
		return {
			input_prefix: opts.prefix,
			input_suffix: opts.suffix,
			n_predict: maxTokens,
			temperature,
			stream: false
		};
	}
	// openai (/v1/completions with FIM `suffix`)
	const body = {
		prompt: opts.prefix,
		suffix: opts.suffix,
		max_tokens: maxTokens,
		temperature,
		stream: false
	};
	if (opts.model) {
		body.model = opts.model;
	}
	return body;
}

/** Pull the completion text out of a backend response. */
function parseCompletion(api, json) {
	if (!json || typeof json !== 'object') {
		return '';
	}
	if (api === 'llama') {
		return typeof json.content === 'string' ? json.content : '';
	}
	const choice = Array.isArray(json.choices) ? json.choices[0] : undefined;
	if (!choice) {
		return '';
	}
	if (typeof choice.text === 'string') {
		return choice.text;
	}
	// Some servers return chat-style choices even on /completions.
	if (choice.message && typeof choice.message.content === 'string') {
		return choice.message.content;
	}
	return '';
}

/**
 * Tidy a raw completion: cap length, and drop any tail that just repeats the
 * start of the suffix (FIM models often regurgitate the text after the cursor,
 * producing duplicated closing brackets/lines).
 * @param {string} raw
 * @param {string} suffix
 * @param {number} [maxChars]
 */
function cleanCompletion(raw, suffix, maxChars = MAX_COMPLETION_CHARS) {
	let text = typeof raw === 'string' ? raw : '';
	if (!text) {
		return '';
	}
	if (text.length > maxChars) {
		text = text.slice(0, maxChars);
	}
	// Remove overlap between the completion's tail and the suffix's head.
	const s = typeof suffix === 'string' ? suffix : '';
	if (s) {
		const maxK = Math.min(text.length, s.length, 80);
		for (let k = maxK; k > 0; k--) {
			if (text.slice(text.length - k) === s.slice(0, k)) {
				text = text.slice(0, text.length - k);
				break;
			}
		}
	}
	// A completion that is only whitespace is not useful.
	return text.trim().length === 0 ? '' : text;
}

/** Register the provider. No-op-safe; reads config live so toggles apply at once. */
function registerInlineCompletions(ctx, output) {
	const state = { failures: 0, backoffUntil: 0 };

	const provider = {
		async provideInlineCompletionItems(document, position, context, token) {
			const config = vscode.workspace.getConfiguration('opencode');
			if (!config.get('inlineCompletions.enabled', true)) {
				return undefined;
			}
			// Only complete in real documents.
			if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') {
				return undefined;
			}
			if (!isLanguageEnabled(document.languageId, config.get('inlineCompletions.disabledLanguages', []))) {
				return undefined;
			}
			if (Date.now() < state.backoffUntil) {
				return undefined;
			}

			const automatic = !context || context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic;
			if (automatic) {
				// Debounce bursts of typing; bail if superseded.
				await delay(AUTOMATIC_DEBOUNCE_MS);
				if (token.isCancellationRequested) {
					return undefined;
				}
			}

			const offset = document.offsetAt(position);
			const fullPrefix = document.getText().slice(0, offset);
			const fullSuffix = document.getText().slice(offset);
			const { prefix, suffix } = clampContext(fullPrefix, fullSuffix);
			if (!prefix.trim() && !suffix.trim()) {
				return undefined;
			}

			const api = config.get('inlineCompletions.api', 'openai');
			const endpoint = config.get('inlineCompletions.endpoint', 'http://127.0.0.1:8765/v1/completions');
			const model = config.get('inlineCompletions.model', '');
			const maxTokens = config.get('inlineCompletions.maxTokens', 128);

			let text;
			try {
				text = await fetchCompletion({ api, endpoint, model, maxTokens, prefix, suffix, token });
				state.failures = 0;
			} catch (err) {
				if (token.isCancellationRequested || (err && err.name === 'AbortError')) {
					return undefined;
				}
				state.failures++;
				if (state.failures >= FAILURE_THRESHOLD) {
					state.backoffUntil = Date.now() + BACKOFF_MS;
					state.failures = 0;
					output.appendLine(`[completions] backing off ${BACKOFF_MS / 1000}s (last: ${err && err.message ? err.message : String(err)})`);
				}
				return undefined;
			}

			const completion = cleanCompletion(text, suffix);
			if (!completion) {
				return undefined;
			}
			return [{ insertText: completion, range: new vscode.Range(position, position) }];
		}
	};

	const selector = [{ scheme: 'file' }, { scheme: 'untitled' }];
	ctx.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider(selector, provider));
	output.appendLine('opencode inline completions registered.');
}

/** Fetch one completion, honoring a timeout and the request cancellation token. */
async function fetchCompletion({ api, endpoint, model, maxTokens, prefix, suffix, token }) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const cancelSub = token && token.onCancellationRequested
		? token.onCancellationRequested(() => controller.abort())
		: null;
	try {
		const res = await fetch(endpoint, {
			method: 'POST',
			signal: controller.signal,
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(buildRequestBody(api, { prefix, suffix, model, maxTokens }))
		});
		if (!res.ok) {
			throw new Error(`${res.status}`);
		}
		const json = await res.json();
		return parseCompletion(api, json);
	} finally {
		clearTimeout(timer);
		if (cancelSub) {
			cancelSub.dispose();
		}
	}
}

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
	registerInlineCompletions,
	// Exported for unit tests.
	clampContext,
	buildRequestBody,
	parseCompletion,
	cleanCompletion,
	isLanguageEnabled
};
