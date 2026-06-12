'use strict';
// Commit message generation for the Source Control input box.
//
// Copilot used to provide the sparkle "Generate Commit Message" action; with
// Copilot removed from this build, this module replaces it with a direct
// OpenRouter chat-completions call — the same API and OPENROUTER_API_KEY env
// var opencode's own OpenRouter provider uses.
//
// The command is contributed to the `scm/inputBox` menu (proposed API
// `contribSourceControlInputBoxMenu`); the SCM toolbar invokes it as
// (rootUri, context, cancellationToken) — see SCMInputWidgetActionRunner in
// src/vs/workbench/contrib/scm/browser/scmInput.ts.

// Guarded so the pure helpers below stay importable by test/unit.js, which
// runs in plain Node without a VS Code host.
let vscode = null;
try { vscode = require('vscode'); } catch { /* tests */ }

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MAX_DIFF_CHARS = 24000;
const REQUEST_TIMEOUT_MS = 30000;

/** Cap the diff so huge changes still fit a small, cheap request. */
function truncateDiff(diff, maxChars = MAX_DIFF_CHARS) {
	if (diff.length <= maxChars) {
		return diff;
	}
	return diff.slice(0, maxChars) + '\n[... diff truncated ...]';
}

/**
 * Build the chat messages for the completion request.
 * @param {{ diff: string, recentSubjects?: string[], untracked?: string[] }} input
 */
function buildCommitMessages({ diff, recentSubjects = [], untracked = [] }) {
	const system = [
		'You write git commit messages.',
		'Reply with ONLY the commit message — no markdown fences, no quotes, no commentary.',
		'Format: one concise subject line in the imperative mood (at most 72 characters).',
		'Add a blank line and a short body only when the change genuinely needs explanation; explain why, not what.',
		'Match the style of the recent commit subjects when sensible.'
	].join(' ');

	const parts = [];
	if (recentSubjects.length) {
		parts.push('Recent commit subjects in this repository:\n' + recentSubjects.map((s) => `- ${s}`).join('\n'));
	}
	if (untracked.length) {
		parts.push('New (untracked) files in this change:\n' + untracked.map((f) => `- ${f}`).join('\n'));
	}
	parts.push('The change to describe:\n\n' + truncateDiff(diff));
	parts.push('Write the commit message.');

	return [
		{ role: 'system', content: system },
		{ role: 'user', content: parts.join('\n\n') }
	];
}

/** Strip fences/quotes/prefixes models sometimes wrap the message in. */
function cleanCommitMessage(raw) {
	let text = String(raw ?? '').trim();
	const fence = /^```[a-zA-Z]*\n([\s\S]*?)\n?```$/.exec(text);
	if (fence) {
		text = fence[1].trim();
	}
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('\u2018') && text.endsWith('\u2019')) || (text.startsWith('\u201C') && text.endsWith('\u201D'))) {
		text = text.slice(1, -1).trim();
	}
	text = text.replace(/^commit message:\s*/i, '');
	return text.trim();
}

/** POST to OpenRouter; resolves to the cleaned message text. */
async function requestCommitMessage({ apiKey, model, messages, signal }) {
	const res = await fetch(OPENROUTER_URL, {
		method: 'POST',
		signal,
		headers: {
			'Authorization': `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
			// Optional OpenRouter attribution headers.
			'X-Title': 'opencode Code-OSS'
		},
		body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 400 })
	});
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
	}
	const data = await res.json();
	const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
	const message = cleanCommitMessage(content);
	if (!message) {
		throw new Error('OpenRouter returned an empty message');
	}
	return message;
}

/** Resolve the built-in git extension API (activating it if needed). */
async function getGitApi() {
	const ext = vscode.extensions.getExtension('vscode.git');
	if (!ext) {
		throw new Error('git extension not found');
	}
	const exports = ext.isActive ? ext.exports : await ext.activate();
	return exports.getAPI(1);
}

function pickRepository(git, rootUri) {
	if (rootUri) {
		const key = rootUri.toString();
		const match = git.repositories.find((r) => r.rootUri.toString() === key);
		if (match) {
			return match;
		}
	}
	return git.repositories[0];
}

/**
 * Command implementation. Invoked from the SCM input toolbar as
 * (rootUri, context, token); also runnable from the palette with no args.
 */
async function generateCommitMessage(output, rootUri, _context, token) {
	const git = await getGitApi();
	const repo = pickRepository(git, rootUri);
	if (!repo) {
		vscode.window.showWarningMessage('opencode: no git repository found.');
		return;
	}

	const apiKey = process.env.OPENROUTER_API_KEY || '';
	if (!apiKey) {
		vscode.window.showErrorMessage(
			'opencode: OPENROUTER_API_KEY is not set. Export it in the shell you launch this build from (same variable opencode uses).'
		);
		return;
	}

	// Prefer staged changes; fall back to the working tree.
	let diff = await repo.diff(true);
	let untracked = [];
	if (!diff.trim()) {
		diff = await repo.diff(false);
		untracked = repo.state.workingTreeChanges
			.filter((c) => c.status === 7 /* UNTRACKED */)
			.map((c) => vscode.workspace.asRelativePath(c.uri));
	}
	if (!diff.trim() && untracked.length === 0) {
		vscode.window.showInformationMessage('opencode: no changes to describe.');
		return;
	}

	let recentSubjects = [];
	try {
		const commits = await repo.log({ maxEntries: 8 });
		recentSubjects = commits.map((c) => String(c.message).split('\n')[0]);
	} catch { /* fresh repo with no commits */ }

	const model = vscode.workspace.getConfiguration('opencode').get('commitMessageModel', 'openrouter/auto');
	const messages = buildCommitMessages({ diff, recentSubjects, untracked });

	// Tie the request to both the toolbar's cancellation and a hard timeout.
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
	const cancelSub = token && token.onCancellationRequested ? token.onCancellationRequested(() => ac.abort()) : undefined;

	try {
		const message = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.SourceControl },
			() => requestCommitMessage({ apiKey, model, messages, signal: ac.signal })
		);
		repo.inputBox.value = message;
		output.appendLine(`[commit-message] generated via ${model} (${diff.length} diff chars)`);
	} catch (err) {
		if (ac.signal.aborted && token && token.isCancellationRequested) {
			return; // user cancelled — stay quiet
		}
		const reason = String(err && err.message || err);
		output.appendLine(`[commit-message] failed: ${reason}`);
		vscode.window.showErrorMessage(`opencode: commit message generation failed — ${reason}`);
	} finally {
		clearTimeout(timer);
		cancelSub?.dispose();
	}
}

function registerCommitMessageGenerator(ctx, output) {
	ctx.subscriptions.push(
		vscode.commands.registerCommand('opencode.generateCommitMessage', (rootUri, context, token) =>
			generateCommitMessage(output, rootUri, context, token))
	);
}

module.exports = {
	registerCommitMessageGenerator,
	// exported for unit tests
	truncateDiff,
	buildCommitMessages,
	cleanCommitMessage
};
