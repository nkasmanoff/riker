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
const { disposeServer } = require('./server');

/** @type {vscode.OutputChannel} */
let output;

/** @type {vscode.StatusBarItem} */
let costStatusItem;
/** Cumulative opencode spend for this window (sums every turn's cost). */
let sessionCostUsd = 0;

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
		approveEdit: (req) => approveEditRequest(req, stream, captured)
	});
	driver.configure({ projectDir, model, mode, resumeSessionId });

	output.appendLine(
		`[turn] dir=${projectDir} model=${model} mode=${mode} resume=${resumeSessionId ?? '(new)'}`
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
				updateCostStatus(event.costUsd);
				output.appendLine(`[turn] cost $${event.costUsd.toFixed(4)} (session $${sessionCostUsd.toFixed(4)})`);
			}
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

/** Reflect per-turn and session cost in the status bar. */
function updateCostStatus(lastTurnUsd) {
	if (!costStatusItem) {
		return;
	}
	costStatusItem.text = `$(robot) ${formatUsd(sessionCostUsd)}`;
	costStatusItem.tooltip = new vscode.MarkdownString(
		`**opencode**\n\nLast turn: ${formatUsd(lastTurnUsd)}\n\nSession total: ${formatUsd(sessionCostUsd)}`
	);
	costStatusItem.show();
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
