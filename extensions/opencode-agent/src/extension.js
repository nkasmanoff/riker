'use strict';
// opencode Agent extension entry point.
//
// Registers a default chat participant that drives the opencode CLI and streams
// its output into VS Code's native chat view. Tool calls are rendered as
// progress; file edits will (in a later phase) flow through the chat-editing
// accept/reject machinery via response.textEdit().

const vscode = require('vscode');
const path = require('path');
const { OpencodeDriver } = require('./opencode');
const { getOpencodeDescriptor } = require('./descriptor');
const { registerLanguageModelProvider } = require('./lmProvider');
const { reconstructBefore, displayDiff } = require('./fileEdits');
const { disposeServer, getServerUrl, api } = require('./server');
const {
	PINNED_VERSION,
	builtinPromptName,
	loadBuiltinPrompt,
	buildSystemPromptDoc,
	parseSystemPromptDoc
} = require('./systemPrompt');
const { registerCommitMessageGenerator } = require('./commitMessage');

/** @type {vscode.OutputChannel} */
let output;

/** @type {vscode.StatusBarItem} */
let costStatusItem;
/** Cumulative opencode spend for this window (sums every turn's cost). */
let sessionCostUsd = 0;
/** Cost of the most recent turn. */
let lastTurnCostUsd = 0;
/** Token counts from the most recent assistant message (context usage). */
let lastTurnTokens = null;
/** Model id used on the most recent turn (for limit/pricing lookups). */
let lastModelId = '';

/**
 * Model catalog from the opencode server (`/config/providers`):
 * "providerID/modelID" -> Model (incl. `limit.context` and per-1M `cost`).
 * Cached for the window; failed fetches retry on next use.
 */
let modelCatalogPromise = null;
function getModelCatalog() {
	if (!modelCatalogPromise) {
		modelCatalogPromise = (async () => {
			const baseUrl = await getServerUrl();
			const res = await api(baseUrl, 'GET', '/config/providers');
			const catalog = new Map();
			for (const provider of res.providers ?? []) {
				for (const [modelId, model] of Object.entries(provider.models ?? {})) {
					catalog.set(`${provider.id}/${modelId}`, model);
				}
			}
			return catalog;
		})();
		modelCatalogPromise.catch(() => { modelCatalogPromise = null; });
	}
	return modelCatalogPromise;
}

/** Set by "Allow for Session" on the edit-approval prompt; window-scoped. */
let sessionAutoApproveEdits = false;

let descriptorPromise = null;
function descriptor() {
	if (!descriptorPromise) {
		descriptorPromise = getOpencodeDescriptor();
	}
	return descriptorPromise;
}

/**
 * @param {vscode.ChatRequest} request
 * @param {vscode.ChatContext} context
 * @param {vscode.ChatResponseStream} stream
 * @param {vscode.CancellationToken} token
 */
async function handler(request, context, stream, token) {
	const desc = await descriptor();

	// Utility commands answered locally — no opencode turn is spent.
	if (request.command === 'system') {
		await handleSystemCommand(request.prompt.trim(), stream);
		return {};
	}
	if (request.command === 'usage') {
		await renderUsageReport(stream, (request.model && request.model.id) || lastModelId || desc.defaultModel);
		return {};
	}

	// Resolve the workspace folder opencode should run in.
	const projectDir =
		vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

	// Reuse the opencode session id from the most recent response in history so
	// `--session` continuity is preserved across turns within the same chat.
	const resumeSessionId = lastOpencodeSessionId(context);

	// Honor the model the user picked in the chat model picker. `request.model.id`
	// is the opaque id we returned from `provideLanguageModelChatInformation`,
	// which is the raw opencode model id (e.g. `frontier/anthropic/claude-…`) —
	// exactly what opencode's `--model` flag expects. Fall back to opencode's
	// own default when no model is resolvable.
	const model = (request.model && request.model.id) || desc.defaultModel;
	const mode = request.command === 'plan' ? 'plan' : desc.defaultMode;
	const systemPrompt = vscode.workspace.getConfiguration('opencode').get('systemPrompt', '');
	lastModelId = model;

	// Captured from the opencode stream; returned in result metadata so the next
	// turn can resume it. `fileEdits` accumulates file mutations (every edit per
	// file, in order) so we can surface accept/reject diffs once the turn
	// settles. `readSnapshots` holds file contents captured from complete `read`
	// tool outputs — the "before" for an overwrite `write` (snapshot-on-read).
	const captured = {
		sessionId: resumeSessionId,
		fileEdits: new Map(),
		readSnapshots: new Map(),
		renderedDiffCallIds: new Set(),
		projectDir
	};

	const driver = new OpencodeDriver((event) => onEvent(event, stream, captured), {
		approveEdit: (req) => approveEditRequest(req, stream, captured),
		askQuestion: (req) => askQuestionRequest(req, stream)
	});
	driver.configure({ projectDir, model, mode, resumeSessionId, systemPrompt });

	output.appendLine(
		`[turn] dir=${projectDir} model=${model} mode=${mode} resume=${resumeSessionId ?? '(new)'}${systemPrompt ? ' systemPrompt=set' : ''}`
	);

	// Interrupt the opencode process if the user cancels the request.
	const cancelSub = token.onCancellationRequested(() => driver.interrupt());

	try {
		if (mode === 'plan') {
			stream.info('Plan mode: opencode is running its read-only "plan" agent. It will propose changes without editing files.');
		}
		stream.progress('opencode is thinking…');
		const { code } = await driver.send(request.prompt);
		if (code && code !== 0) {
			output.appendLine(`[turn] opencode exited with code ${code}`);
		}
		// Surface file edits as accept/reject diffs now that the turn is done and
		// disk state is final.
		await surfaceFileEdits(captured.fileEdits, stream);
	} catch (err) {
		stream.warning(`opencode error: ${err && err.message ? err.message : String(err)}`);
	} finally {
		cancelSub.dispose();
	}

	return { metadata: { opencodeSessionId: captured.sessionId } };
}

/**
 * Surface the file edits opencode made during a turn as accept/reject diffs.
 *
 * opencode writes to disk eagerly, so by now `filePath` already holds the final
 * ("after") content. To get VS Code's editing UI to show a before/after diff we:
 *   1. reconstruct the file's pre-turn ("before") content by chaining the
 *      edits' diffs in reverse from the current disk content;
 *   2. write that "before" content back to disk;
 *   3. open an externalEdit window (VS Code snapshots the restored original);
 *   4. inside the callback, restore the real "after" content.
 * VS Code then diffs before -> after and renders accept/reject pills.
 *
 * If reconstruction can't be proven correct (e.g. a blind overwrite with no
 * diff), we skip the replay for that file and emit a plain reference instead —
 * never risking the file's contents.
 *
 * @param {Map<string, any[]>} fileEdits filePath -> ordered edit records
 * @param {vscode.ChatResponseStream} stream
 */
async function surfaceFileEdits(fileEdits, stream) {
	for (const [filePath, edits] of fileEdits) {
		const uri = vscode.Uri.file(filePath);
		let afterText;
		try {
			afterText = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		} catch {
			// File was deleted or is unreadable; fall back to a reference.
			stream.reference(uri);
			continue;
		}

		// Chain edits in reverse: current disk = after of the last edit. Walk
		// backwards, reconstructing the "before" of each, to recover the
		// pre-turn original.
		let beforeText = afterText;
		let reconstructable = true;
		for (let i = edits.length - 1; i >= 0; i--) {
			const result = reconstructBefore(edits[i], beforeText);
			if (!result) {
				reconstructable = false;
				break;
			}
			beforeText = result.before;
		}

		if (!reconstructable || beforeText === afterText) {
			// Can't safely show a diff (blind overwrite, or no net change).
			// Surface the file as a reference so the user can still inspect it.
			stream.reference(uri);
			output.appendLine(`[edit] ${filePath}: no safe diff (reference only)`);
			continue;
		}

		try {
			// externalEdit snapshots the file as "before" when it starts (before
			// the callback runs), then diffs that against disk after the callback
			// resolves. So we restore the original to disk *first*, then re-apply
			// the real result inside the callback as the tracked agent edit.
			await vscode.workspace.fs.writeFile(uri, Buffer.from(beforeText, 'utf8'));
			await stream.externalEdit(uri, async () => {
				await vscode.workspace.fs.writeFile(uri, Buffer.from(afterText, 'utf8'));
			});
			output.appendLine(`[edit] ${filePath}: surfaced (${edits.length} edit(s))`);
		} catch (err) {
			// If externalEdit isn't available or fails, make sure the final
			// content is on disk and fall back to a reference.
			try {
				await vscode.workspace.fs.writeFile(uri, Buffer.from(afterText, 'utf8'));
			} catch { /* best effort */ }
			stream.reference(uri);
			output.appendLine(`[edit] ${filePath}: externalEdit failed (${err && err.message})`);
		}
	}
}

/**
 * Approve or deny one pending file edit (driver `approveEdit` callback).
 * Called while the opencode tool is BLOCKED on the permission gate, i.e.
 * before anything is written to disk. Streams the pending diff into chat,
 * then (in "ask" mode) prompts the user.
 *
 * @param {{ filepath?: string, patterns: string[], diff?: string, callID?: string }} req
 * @param {vscode.ChatResponseStream} stream
 * @param {{ renderedDiffCallIds: Set<string> }} captured
 * @returns {Promise<'once' | 'reject'>}
 */
async function approveEditRequest(req, stream, captured) {
	const fileLabel = req.filepath ? shortPath(req.filepath) : (req.patterns[0] ?? 'file');

	// Stream the diff before the edit applies — this is the true pre-apply
	// pending diff. The tool-result handler skips re-rendering it (dedupe by
	// callID).
	if (req.diff) {
		const diffText = displayDiff({ gateDiff: req.diff });
		if (diffText) {
			if (req.callID) {
				captured.renderedDiffCallIds.add(req.callID);
			}
			stream.markdown(`\n\n**${fileLabel}**\n\n\`\`\`diff\n${diffText}\n\`\`\`\n\n`);
		}
	}

	const mode = vscode.workspace.getConfiguration('opencode').get('editApproval', 'ask');
	if (mode !== 'ask' || sessionAutoApproveEdits) {
		return 'once';
	}

	stream.progress(`Waiting for approval to edit ${fileLabel}…`);
	const choice = await vscode.window.showInformationMessage(
		`opencode wants to edit ${fileLabel}`,
		'Allow',
		'Allow for Session',
		'Deny'
	);
	if (choice === 'Allow for Session') {
		sessionAutoApproveEdits = true;
		return 'once';
	}
	if (choice === 'Allow') {
		return 'once';
	}
	// Explicit deny, or the prompt was dismissed: never apply silently.
	stream.warning(`Edit to ${fileLabel} denied${choice ? '' : ' (approval prompt dismissed)'}.`);
	return 'reject';
}

/**
 * Answer an opencode question request (driver `askQuestion` callback).
 * Called while the question tool is BLOCKED server-side awaiting a reply.
 *
 * The full question text and every option are rendered into the chat
 * transcript (nothing hidden behind a collapsed progress row), then the user
 * picks via QuickPick — clickable options, multi-select when the question
 * allows it, and free-text via "Custom answer…" (opencode's `custom` flag
 * defaults to true). Dismissing the picker rejects the question: the tool
 * errors with "user dismissed" and the model continues.
 *
 * @param {{ id: string, questions: any[], tool?: any }} req
 * @param {vscode.ChatResponseStream} stream
 * @returns {Promise<string[][] | null>} answers (selected labels per question), or null to reject
 */
async function askQuestionRequest(req, stream) {
	const questions = Array.isArray(req.questions) ? req.questions : [];
	if (questions.length === 0) {
		return null;
	}
	const answers = [];
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i] ?? {};
		const header = typeof q.header === 'string' && q.header ? q.header : `Question ${i + 1}`;
		const text = typeof q.question === 'string' ? q.question : '';
		const options = Array.isArray(q.options) ? q.options : [];

		const md = [`\n\n**${header}**`];
		if (text) {
			md.push('', text, '');
		}
		for (const opt of options) {
			md.push(`- **${opt && opt.label ? opt.label : ''}**${opt && opt.description ? ` — ${opt.description}` : ''}`);
		}
		stream.markdown(md.join('\n') + '\n');
		stream.progress(`Waiting for your answer: ${header}…`);

		const answer = await promptForAnswer(q, header, i, questions.length);
		if (answer === null) {
			stream.warning('Question dismissed — opencode will continue without an answer.');
			return null;
		}
		answers.push(answer);
		stream.markdown(`\n*You answered: ${answer.length ? answer.join(', ') : '(no selection)'}*\n\n`);
	}
	return answers;
}

const CUSTOM_ANSWER_LABEL = '$(edit) Custom answer…';

/**
 * QuickPick (and InputBox for free text) for a single question.
 * @returns {Promise<string[] | null>} selected labels / typed text, or null if dismissed
 */
async function promptForAnswer(q, header, index, total) {
	const options = Array.isArray(q.options) ? q.options : [];
	const allowCustom = q.custom !== false; // opencode default: custom answers allowed
	const title = total > 1 ? `opencode asks (${index + 1}/${total}): ${header}` : `opencode asks: ${header}`;
	const questionText = typeof q.question === 'string' ? q.question : '';

	/** @type {vscode.QuickPickItem[]} */
	const items = options.map((opt) => ({
		label: String(opt && opt.label ? opt.label : ''),
		description: opt && opt.description ? String(opt.description) : undefined
	}));
	if (allowCustom) {
		items.push({ label: CUSTOM_ANSWER_LABEL, description: 'Type your own answer', alwaysShow: true });
	}

	if (items.length === 0) {
		const typed = await vscode.window.showInputBox({ title, prompt: questionText, ignoreFocusOut: true });
		return typed === undefined ? null : [typed];
	}

	const picked = await vscode.window.showQuickPick(items, {
		title,
		placeHolder: questionText,
		canPickMany: q.multiple === true,
		ignoreFocusOut: true,
		matchOnDescription: true
	});
	if (picked === undefined) {
		return null;
	}

	const pickedItems = Array.isArray(picked) ? picked : [picked];
	const labels = [];
	let wantsCustom = false;
	for (const item of pickedItems) {
		if (item.label === CUSTOM_ANSWER_LABEL) {
			wantsCustom = true;
		} else {
			labels.push(item.label);
		}
	}
	if (wantsCustom) {
		const typed = await vscode.window.showInputBox({
			title,
			prompt: questionText,
			placeHolder: 'Your answer',
			ignoreFocusOut: true
		});
		if (typed === undefined && labels.length === 0) {
			return null; // custom was the only selection and it was dismissed
		}
		if (typed) {
			labels.push(typed);
		}
	}
	return labels;
}

/** Find the opencode session id stored on the most recent response turn. */
function lastOpencodeSessionId(context) {
	const history = context?.history ?? [];
	for (let i = history.length - 1; i >= 0; i--) {
		const turn = history[i];
		const id = turn && turn.result && turn.result.metadata && turn.result.metadata.opencodeSessionId;
		if (id) {
			return String(id);
		}
	}
	return undefined;
}

/**
 * Translate a normalized opencode event into chat response stream output.
 * @param {any} event
 * @param {vscode.ChatResponseStream} stream
 * @param {{ sessionId: string | undefined, fileEdits: Map<string, any[]>, readSnapshots: Map<string, string>, renderedDiffCallIds: Set<string>, projectDir: string }} captured
 */
function onEvent(event, stream, captured) {
	switch (event.kind) {
		case 'session':
			if (event.sessionId) {
				captured.sessionId = event.sessionId;
			}
			break;
		case 'text-delta':
			stream.markdown(event.text);
			break;
		case 'thinking-delta':
			// Stream into the collapsible reasoning UI. The driver keys deltas by
			// opencode part id, so consecutive parts render as separate blocks.
			stream.thinkingProgress({ id: event.id || 'opencode-thinking', text: event.text });
			break;
		case 'tool-start':
			stream.progress(toolStartLabel(event));
			break;
		case 'tool-result': {
			stream.progress(toolResultLabel(event));
			// Snapshot-on-read: remember the file's exact content from a complete
			// `read` so a later overwrite `write` can show a real before/after.
			if (event.fileRead && event.fileRead.filePath) {
				captured.readSnapshots.set(
					path.resolve(captured.projectDir, event.fileRead.filePath),
					event.fileRead.content
				);
			}
			// Record file mutations (in order) so they can be surfaced as
			// accept/reject diffs after the turn completes. opencode may touch
			// the same file several times; we keep every edit so we can chain
			// their diffs back to the file's original pre-turn content.
			if (event.fileEdit && event.fileEdit.filePath) {
				const filePath = path.resolve(captured.projectDir, event.fileEdit.filePath);
				const record = { ...event.fileEdit, filePath };
				if (record.tool === 'write' && captured.readSnapshots.has(filePath)) {
					record.snapshotBefore = captured.readSnapshots.get(filePath);
				}
				// Any mutation makes a prior read snapshot stale.
				captured.readSnapshots.delete(filePath);
				const list = captured.fileEdits.get(filePath) ?? [];
				list.push(record);
				captured.fileEdits.set(filePath, list);

				// Render the diff inline (Cursor-style) — unless the approval
				// gate already streamed this edit's pending diff.
				if (!(event.id && captured.renderedDiffCallIds.has(event.id))) {
					const diffText = displayDiff(record);
					if (diffText) {
						stream.markdown(`\n\n**${shortPath(filePath)}**\n\n\`\`\`diff\n${diffText}\n\`\`\`\n\n`);
					}
				}
			}
			break;
		}
		case 'turn-complete':
			if (typeof event.costUsd === 'number' && event.costUsd > 0) {
				sessionCostUsd += event.costUsd;
				lastTurnCostUsd = event.costUsd;
				output.appendLine(`[turn] cost $${event.costUsd.toFixed(4)} (session $${sessionCostUsd.toFixed(4)})`);
			}
			if (event.tokens) {
				lastTurnTokens = event.tokens;
			}
			updateUsageStatus().catch(() => { /* status bar is best effort */ });
			break;
		case 'error':
			stream.warning(`opencode: ${event.message}`);
			break;
		case 'status':
			output.appendLine(`[status] ${event.status}`);
			break;
		default:
			break;
	}
}

function formatUsd(value) {
	return '$' + (value >= 0.1 ? value.toFixed(2) : value.toFixed(4));
}

function formatTokens(n) {
	if (n >= 1e6) {
		return (n / 1e6).toFixed(1) + 'M';
	}
	if (n >= 1000) {
		return Math.round(n / 1000) + 'k';
	}
	return String(n);
}

/**
 * Approximate context consumption from the last assistant message's token
 * counts: everything the model processed that step (prompt = input + cache
 * read/write) plus what it produced (output + reasoning) is roughly the
 * prompt size of the next turn.
 */
function contextTokens(tokens) {
	if (!tokens) {
		return 0;
	}
	const cache = tokens.cache ?? {};
	return (tokens.input ?? 0) + (cache.read ?? 0) + (cache.write ?? 0)
		+ (tokens.output ?? 0) + (tokens.reasoning ?? 0);
}

/** Look up the active model's context limit (undefined if unknown). */
async function lookupContextLimit(modelId) {
	try {
		const model = (await getModelCatalog()).get(modelId);
		const limit = model && model.limit && model.limit.context;
		return typeof limit === 'number' && limit > 0 ? limit : undefined;
	} catch {
		return undefined;
	}
}

/** Reflect cost and context usage in the status bar. */
async function updateUsageStatus() {
	if (!costStatusItem) {
		return;
	}
	if (sessionCostUsd <= 0 && !lastTurnTokens) {
		return; // stay hidden until the first turn reports something
	}
	const used = contextTokens(lastTurnTokens);
	const limit = used ? await lookupContextLimit(lastModelId) : undefined;
	const pct = used && limit ? Math.round((used / limit) * 100) : undefined;

	const segments = [`$(robot) ${formatUsd(sessionCostUsd)}`];
	if (pct !== undefined) {
		segments.push(`${pct}%`);
	}
	costStatusItem.text = segments.join(' · ');

	const lines = ['**opencode**', '', `Last turn: ${formatUsd(lastTurnCostUsd)}`, '', `Session total: ${formatUsd(sessionCostUsd)}`];
	if (used) {
		lines.push('', `Context: ≈${formatTokens(used)}${limit ? ` of ${formatTokens(limit)} (${pct}%)` : ''}`);
		const t = lastTurnTokens;
		const cache = t.cache ?? {};
		lines.push('', `Last turn tokens: ${formatTokens(t.input ?? 0)} in · ${formatTokens(t.output ?? 0)} out · ${formatTokens(t.reasoning ?? 0)} reasoning · ${formatTokens(cache.read ?? 0)} cache read`);
	}
	lines.push('', 'Run `/usage` in chat for details.');
	costStatusItem.tooltip = new vscode.MarkdownString(lines.join('\n'));
	costStatusItem.show();
}

/**
 * The system prompt as an editable markdown document: a writable
 * FileSystemProvider whose single file (`opencode:/system-prompt.md`) shows
 * the FULL prompt the agent runs with — the base agent prompt (the build
 * agent's override if set, else opencode's built-in provider prompt for the
 * current model, from our vendored copies) plus the extra instructions from
 * the `opencode.systemPrompt` setting. On save:
 *   - BASE section changed  -> written to the workspace's `opencode.json` as
 *     `agent.build.prompt` (REPLACES the built-in prompt), then
 *     POST /instance/dispose so the running server reloads it. Restoring the
 *     built-in text exactly removes the override again.
 *     (Why not PATCH /config: at opencode v1.15.10 it persists to a
 *     `config.json` that the config loader never reads back — verified live —
 *     so the override would silently never apply.)
 *   - EXTRA section -> the opencode.systemPrompt setting (appended per turn).
 */
const SYSTEM_PROMPT_URI = vscode.Uri.parse('opencode:/system-prompt.md');

class SystemPromptFs {
	constructor() {
		this._emitter = new vscode.EventEmitter();
		this.onDidChangeFile = this._emitter.event;
		this._mtime = Date.now();
		this._selfWrite = false;
		this._lastDoc = Buffer.from('', 'utf8');
		// Base text as last rendered (trimmed) — saves only patch the agent
		// prompt when the section actually changed from what was shown.
		this._renderedBase = null;
		// The built-in default text (trimmed), when known: restoring it
		// exactly clears the override instead of pinning a copy.
		this._renderedBuiltin = null;
	}

	_projectDir() {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
	}

	async _assemble() {
		const extras = vscode.workspace.getConfiguration('opencode').get('systemPrompt', '');
		let baseText = '';
		let baseLabel = '';
		let builtinText = null;
		try {
			const modelId = lastModelId || (await descriptor()).defaultModel;
			let apiId = '';
			try {
				const model = (await getModelCatalog()).get(modelId);
				apiId = (model && model.api && model.api.id) || '';
			} catch { /* selection falls back to the model id */ }
			const promptName = builtinPromptName(apiId || modelId);
			builtinText = loadBuiltinPrompt(promptName);

			const baseUrl = await getServerUrl();
			const agents = await api(baseUrl, 'GET', '/agent', { directory: this._projectDir() });
			const build = Array.isArray(agents) ? agents.find((a) => a && a.name === 'build') : undefined;
			if (build && typeof build.prompt === 'string' && build.prompt.trim()) {
				baseText = build.prompt;
				baseLabel = 'custom override for the "build" agent (set via this editor or opencode config) — REPLACES the built-in prompt';
			} else if (builtinText) {
				baseText = builtinText;
				baseLabel = `opencode's built-in "${promptName}" prompt, selected for ${modelId} (local copy pinned to opencode v${PINNED_VERSION})`;
			} else {
				baseLabel = 'unavailable (no override set and the built-in prompt copy is missing)';
			}
		} catch (err) {
			baseLabel = `unavailable (opencode server error: ${String(err && err.message || err)})`;
		}
		this._renderedBase = baseText.trim();
		this._renderedBuiltin = builtinText ? builtinText.trim() : null;
		this._lastDoc = Buffer.from(buildSystemPromptDoc({ baseLabel, baseText, extras }), 'utf8');
		this._mtime = Date.now();
		return this._lastDoc;
	}

	/** Refresh open editors when the setting changes outside writeFile. */
	notifyExternalChange() {
		if (this._selfWrite) {
			return;
		}
		this._mtime = Date.now();
		this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri: SYSTEM_PROMPT_URI }]);
	}

	watch() {
		return new vscode.Disposable(() => { });
	}

	stat() {
		return { type: vscode.FileType.File, ctime: 0, mtime: this._mtime, size: this._lastDoc.byteLength };
	}

	readDirectory() {
		return [];
	}

	createDirectory() { }

	readFile() {
		return this._assemble();
	}

	async writeFile(_uri, content) {
		const text = Buffer.from(content).toString('utf8');
		const parsed = parseSystemPromptDoc(text);
		if (!parsed) {
			throw vscode.FileSystemError.Unavailable(
				'The section marker lines were modified — nothing was saved. Reopen with /system.'
			);
		}
		this._selfWrite = true;
		try {
			const config = vscode.workspace.getConfiguration('opencode');
			if (parsed.extras !== config.get('systemPrompt', '').trim()) {
				await config.update('systemPrompt', parsed.extras, systemPromptTarget());
			}
			if (this._renderedBase !== null && parsed.base !== this._renderedBase) {
				// Restoring the built-in text exactly removes the override.
				const prompt = this._renderedBuiltin !== null && parsed.base === this._renderedBuiltin ? undefined : parsed.base;
				await this._saveBaseOverride(prompt);
				this._renderedBase = parsed.base;
				output.appendLine(prompt !== undefined
					? '[system] build agent prompt override saved (replaces the built-in prompt)'
					: '[system] build agent prompt override removed (back to the built-in prompt)');
			}
		} finally {
			this._selfWrite = false;
		}
		this._lastDoc = Buffer.from(text, 'utf8');
		this._mtime = Date.now();
		this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri: SYSTEM_PROMPT_URI }]);
	}

	/**
	 * Set (or remove, when `prompt` is undefined) the build agent's prompt
	 * override in the workspace's `opencode.json`, then dispose the server's
	 * project instance so the next turn runs with the new config.
	 */
	async _saveBaseOverride(prompt) {
		const dir = this._projectDir();
		const uri = vscode.Uri.file(path.join(dir, 'opencode.json'));
		let json = {};
		let raw = null;
		try {
			raw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		} catch { /* no existing file — start fresh */ }
		if (raw !== null) {
			try {
				json = JSON.parse(raw);
			} catch {
				// JSONC/comments or malformed — never risk clobbering it.
				throw vscode.FileSystemError.Unavailable(
					'opencode.json exists but is not plain JSON; edit agent.build.prompt there manually.'
				);
			}
		}
		if (typeof json !== 'object' || json === null || Array.isArray(json)) {
			json = {};
		}
		if (prompt !== undefined) {
			json.agent = json.agent && typeof json.agent === 'object' ? json.agent : {};
			json.agent.build = json.agent.build && typeof json.agent.build === 'object' ? json.agent.build : {};
			json.agent.build.prompt = prompt;
		} else {
			if (json.agent && json.agent.build) {
				delete json.agent.build.prompt;
				if (Object.keys(json.agent.build).length === 0) {
					delete json.agent.build;
				}
				if (Object.keys(json.agent).length === 0) {
					delete json.agent;
				}
			}
			if (Object.keys(json).length === 0) {
				// Nothing left — remove the file rather than leaving `{}` behind.
				try { await vscode.workspace.fs.delete(uri); } catch { /* already gone */ }
				await this._disposeInstance(dir);
				return;
			}
		}
		await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(json, null, 2) + '\n', 'utf8'));
		await this._disposeInstance(dir);
	}

	async _disposeInstance(dir) {
		try {
			const baseUrl = await getServerUrl();
			await api(baseUrl, 'POST', '/instance/dispose', { directory: dir });
		} catch (err) {
			// The override still applies on the next server restart.
			output.appendLine(`[system] instance dispose failed (config reload deferred): ${String(err && err.message || err)}`);
		}
	}

	delete() {
		throw vscode.FileSystemError.NoPermissions('Use /system clear instead.');
	}

	rename() {
		throw vscode.FileSystemError.NoPermissions();
	}
}

/** @type {SystemPromptFs} */
let systemPromptFs;

function systemPromptTarget() {
	return vscode.workspace.workspaceFolders?.length
		? vscode.ConfigurationTarget.Workspace
		: vscode.ConfigurationTarget.Global;
}

/** Open the system prompt as a markdown editor beside the chat. */
async function openSystemPromptEditor() {
	const doc = await vscode.workspace.openTextDocument(SYSTEM_PROMPT_URI);
	await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Active, preview: false });
}

/**
 * `/system` — manage the extra system instructions that ride along on every
 * turn (`opencode.systemPrompt`). opencode appends them after its built-in
 * agent prompt, so they augment rather than replace it.
 *
 * Bare `/system` opens the prompt as an editable markdown document (save to
 * apply); `/system <text>` sets it inline; `/system clear` removes it.
 */
async function handleSystemCommand(text, stream) {
	const config = vscode.workspace.getConfiguration('opencode');
	const current = config.get('systemPrompt', '');

	if (!text) {
		await openSystemPromptEditor();
		stream.markdown(
			'Opened opencode\'s full system prompt in an editor — the base agent prompt plus '
			+ (current ? 'your extra instructions' : 'an (empty) extra-instructions section')
			+ '. Edit either section and **save** to apply: base edits replace the built-in prompt '
			+ '(restore the built-in text to go back to the default); extras are appended every turn. '
			+ '`/system <text>` still sets the extras inline, `/system clear` removes them.'
		);
		return;
	}

	const target = systemPromptTarget();

	if (text.toLowerCase() === 'clear') {
		// Clear both scopes so a stale global value doesn't resurface.
		await config.update('systemPrompt', undefined, vscode.ConfigurationTarget.Workspace).then(undefined, () => { });
		await config.update('systemPrompt', undefined, vscode.ConfigurationTarget.Global);
		stream.markdown('Extra system instructions cleared.');
		return;
	}

	await config.update('systemPrompt', text, target);
	stream.markdown(
		'Extra system instructions set — they will be appended to opencode\'s agent prompt on every turn from now on:\n\n'
		+ `> ${text.split('\n').join('\n> ')}`
	);
}

/**
 * `/usage` — render context, token, and cost usage for this window into chat.
 */
async function renderUsageReport(stream, modelId) {
	if (!lastTurnTokens && sessionCostUsd <= 0) {
		stream.markdown('No opencode turns in this window yet — usage appears after the first response.');
		return;
	}

	let model;
	try {
		model = (await getModelCatalog()).get(modelId);
	} catch { /* report what we have without the catalog */ }
	const limit = model && model.limit && typeof model.limit.context === 'number' ? model.limit.context : undefined;
	const used = contextTokens(lastTurnTokens);

	const lines = [`**opencode usage** — \`${modelId}\``, ''];
	if (lastTurnTokens) {
		const t = lastTurnTokens;
		const cache = t.cache ?? {};
		lines.push(`- **Context:** ≈${formatTokens(used)} tokens${limit ? ` of ${formatTokens(limit)} (${Math.round((used / limit) * 100)}%)` : ''}`);
		lines.push(`- **Last turn tokens:** ${formatTokens(t.input ?? 0)} input · ${formatTokens(t.output ?? 0)} output · ${formatTokens(t.reasoning ?? 0)} reasoning · ${formatTokens(cache.read ?? 0)} cache read · ${formatTokens(cache.write ?? 0)} cache write`);
	}
	lines.push(`- **Cost:** ${formatUsd(lastTurnCostUsd)} last turn · ${formatUsd(sessionCostUsd)} total this window`);
	if (model && model.cost) {
		const rates = [`$${model.cost.input}/M input`, `$${model.cost.output}/M output`];
		if (model.cost.cache) {
			rates.push(`$${model.cost.cache.read}/M cache read`, `$${model.cost.cache.write}/M cache write`);
		}
		lines.push(`- **Model pricing:** ${rates.join(' · ')}`);
	}
	stream.markdown(lines.join('\n') + '\n');
}

function toolStartLabel(event) {
	const target = describeTarget(event);
	return target ? `${event.name} ${target}` : `${event.name}`;
}

function toolResultLabel(event) {
	const target = describeTarget(event);
	const verb = event.isError ? 'failed' : 'done';
	return target ? `${event.name} ${target} — ${verb}` : `${event.name} — ${verb}`;
}

function describeTarget(event) {
	const input = event.input || {};
	if (typeof input.filePath === 'string') {
		return shortPath(input.filePath);
	}
	if (typeof input.path === 'string') {
		return shortPath(input.path);
	}
	if (typeof input.pattern === 'string') {
		return `"${input.pattern}"`;
	}
	if (typeof input.command === 'string') {
		return '`' + input.command.slice(0, 60) + '`';
	}
	return '';
}

function shortPath(p) {
	const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (folder && p.startsWith(folder)) {
		return p.slice(folder.length + 1);
	}
	return p;
}

function activate(ctx) {
	output = vscode.window.createOutputChannel('opencode Agent');
	ctx.subscriptions.push(output);

	// Cost readout; hidden until the first turn reports a cost.
	costStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	costStatusItem.name = 'opencode cost';
	ctx.subscriptions.push(costStatusItem);

	const participant = vscode.chat.createChatParticipant('opencode.agent', handler);
	participant.iconPath = new vscode.ThemeIcon('robot');
	ctx.subscriptions.push(participant);

	// System prompt as an editable markdown doc (saves write the setting).
	systemPromptFs = new SystemPromptFs();
	ctx.subscriptions.push(vscode.workspace.registerFileSystemProvider('opencode', systemPromptFs, { isCaseSensitive: true }));
	ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
		if (e.affectsConfiguration('opencode.systemPrompt')) {
			systemPromptFs.notifyExternalChange();
		}
	}));
	ctx.subscriptions.push(vscode.commands.registerCommand('opencode.editSystemPrompt', () => openSystemPromptEditor()));

	// Sparkle action in the SCM input box (replaces Copilot's, via OpenRouter).
	registerCommitMessageGenerator(ctx, output);

	// Register opencode's models as a language model provider so the chat
	// framework can resolve request.model (and populate the model picker).
	registerLanguageModelProvider(ctx, output).catch((err) => {
		output.appendLine(`Failed to register language model provider: ${err && err.message}`);
	});

	// Shut the shared opencode server down with the window.
	ctx.subscriptions.push({ dispose: () => disposeServer() });

	output.appendLine('opencode Agent activated.');
}

function deactivate() {
	disposeServer();
}

module.exports = { activate, deactivate };
