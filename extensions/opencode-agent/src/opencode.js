'use strict';
// Drives an opencode conversation against a persistent `opencode serve`
// instance (see server.js for why not `opencode run`).
//
// Per turn we: subscribe to the project's `/event` SSE stream, ensure a
// session, then POST the prompt. Streaming events are translated into the
// normalized callback vocabulary consumed by the chat participant:
//
//   message.part.updated  part created / state change / finished
//   message.part.delta    token-level text for text AND reasoning parts
//   session.idle          turn finished
//   session.error         surfaced as an error event
//   permission.asked      auto-approved (parity with non-interactive run)
//
// Pre-apply edit gate: sessions are created with a permission ruleset that
// makes every file edit *ask* first. The `permission.asked` event arrives
// BEFORE the tool writes to disk and carries `metadata.diff` — the exact
// old→new unified patch opencode computed pre-write. We stash it by callID,
// reply (so the next edit asks again), and attach it to the eventual
// tool-result as `fileEdit.gateDiff`. This recovers a before/after diff even
// for blind `write` overwrites with no prior read.
//
// The reply is delegated to an optional `approveEdit` callback (the real
// approve/deny UI lives in the extension): it receives the pending
// { filepath, patterns, diff, callID } while the tool is still blocked and
// returns 'once' to apply or 'reject' to deny. Without a callback the gate
// auto-approves with "once".

const { parseReadToolOutput } = require('./fileEdits');
const { getServerUrl, api, subscribeEvents } = require('./server');

// Force opencode to ask before every file edit so we can capture the
// pre-write diff (see "Pre-apply edit gate" above).
const EDIT_GATE_RULESET = [{ permission: 'edit', pattern: '*', action: 'ask' }];

/** Map opencode's lowercase tool names to display names. */
function normalizeToolName(name) {
	const map = {
		read: 'Read',
		write: 'Write',
		edit: 'Edit',
		patch: 'Edit',
		bash: 'Bash',
		grep: 'Grep',
		glob: 'Glob',
		list: 'List',
		webfetch: 'WebFetch',
		task: 'Task',
		todowrite: 'TodoWrite',
		todoread: 'TodoRead'
	};
	return map[name] ?? name.charAt(0).toUpperCase() + name.slice(1);
}

/** Split "frontier/anthropic/claude-x" into { providerID, modelID }. */
function splitModelId(id) {
	const slash = id.indexOf('/');
	if (slash === -1) {
		return undefined;
	}
	return { providerID: id.slice(0, slash), modelID: id.slice(slash + 1) };
}

class OpencodeDriver {
	/**
	 * @param {(event: any) => void} emit normalized event sink
	 * @param {{ approveEdit?: (req: { filepath?: string, patterns: string[], diff?: string, callID?: string }) => Promise<'once' | 'reject'> }} [opts]
	 */
	constructor(emit, opts = {}) {
		this.emit = emit;
		this.approveEdit = typeof opts.approveEdit === 'function' ? opts.approveEdit : null;
		this.sessionId = null;
		this.emittedSession = false;

		// Per-turn state.
		this.abortController = null;
		this.textByPart = new Map(); // partID -> accumulated text
		this.partKinds = new Map(); // partID -> 'text' | 'reasoning'
		this.userMessageIds = new Set(); // the SSE stream echoes our own prompt
		this.seenToolStart = new Set();
		this.seenToolResult = new Set();
		this.seenCostParts = new Set();
		this.gateDiffs = new Map(); // callID -> { filepath, diff } from permission.asked
		this.turnCost = 0;
		this.interrupted = false;

		this.projectDir = process.cwd();
		this.model = '';
		this.mode = 'build';
	}

	configure(opts) {
		if (opts.projectDir && opts.projectDir !== this.projectDir) {
			this.projectDir = opts.projectDir;
		}
		if (opts.resumeSessionId) {
			this.sessionId = opts.resumeSessionId;
		}
		if (opts.model) {
			this.model = opts.model;
		}
		if (opts.mode) {
			this.mode = opts.mode;
		}
		return this.sessionId;
	}

	/**
	 * Run one turn. Resolves when the session goes idle.
	 * @param {string} text
	 * @returns {Promise<{ code: number | null }>}
	 */
	async send(text) {
		if (this.abortController) {
			return { code: null }; // a turn is already in flight
		}
		this.resetTurn();

		let baseUrl;
		try {
			baseUrl = await getServerUrl();
		} catch (err) {
			this.emit({ kind: 'error', message: String(err && err.message || err) });
			return { code: 1 };
		}

		const ac = new AbortController();
		this.abortController = ac;

		let resolveIdle;
		const idle = new Promise((resolve) => { resolveIdle = resolve; });

		try {
			// Ensure a session before subscribing so the event filter has an id.
			if (!this.sessionId) {
				const session = await api(baseUrl, 'POST', '/session', {
					directory: this.projectDir,
					body: { permission: EDIT_GATE_RULESET }
				});
				this.sessionId = session.id;
			}
			this.emitSession();

			// Subscribe to events BEFORE sending the prompt so nothing is missed.
			await subscribeEvents(baseUrl, this.projectDir, (event) => {
				try {
					this.handleServerEvent(event, baseUrl, resolveIdle);
				} catch { /* never let one bad event kill the stream */ }
			}, ac.signal);

			const body = { parts: [{ type: 'text', text }] };
			const model = this.model ? splitModelId(this.model) : undefined;
			if (model) {
				body.model = model;
			}
			// `build` is opencode's default agent; only specify a non-default one.
			if (this.mode && this.mode !== 'build') {
				body.agent = this.mode;
			}

			// The POST resolves when the reply finishes generating, but trailing
			// events (final part updates, session.idle) can arrive just after.
			// session.idle is authoritative; the timer is a safety net.
			const post = api(baseUrl, 'POST', `/session/${this.sessionId}/message`, {
				directory: this.projectDir,
				body
			});

			let idleTimeout;
			await Promise.race([
				idle,
				post.then(() => new Promise((resolve) => {
					idleTimeout = setTimeout(resolve, 10000);
					idle.then(() => { clearTimeout(idleTimeout); resolve(); });
				}))
			]);
			await post.catch(() => { /* error already surfaced via session.error/abort */ });

			this.emit({ kind: 'turn-complete', costUsd: this.turnCost });
			return { code: this.interrupted ? null : 0 };
		} catch (err) {
			if (!this.interrupted) {
				this.emit({ kind: 'error', message: String(err && err.message || err) });
			}
			this.emit({ kind: 'turn-complete', costUsd: this.turnCost });
			return { code: this.interrupted ? null : 1 };
		} finally {
			ac.abort();
			if (this.abortController === ac) {
				this.abortController = null;
			}
		}
	}

	interrupt() {
		this.interrupted = true;
		const sessionId = this.sessionId;
		if (sessionId) {
			getServerUrl()
				.then((baseUrl) => api(baseUrl, 'POST', `/session/${sessionId}/abort`, { directory: this.projectDir }))
				.catch(() => { /* best effort */ });
		}
		this.abortController?.abort();
		this.emit({ kind: 'status', status: 'interrupted' });
	}

	reset() {
		this.abortController?.abort();
		this.sessionId = null;
		this.emittedSession = false;
	}

	dispose() {
		this.abortController?.abort();
	}

	// ── internals ──────────────────────────────────────────────────────────

	resetTurn() {
		this.textByPart.clear();
		this.partKinds.clear();
		this.seenToolStart.clear();
		this.seenToolResult.clear();
		this.seenCostParts.clear();
		this.gateDiffs.clear();
		this.turnCost = 0;
		this.interrupted = false;
	}

	emitSession() {
		if (!this.emittedSession && this.sessionId) {
			this.emittedSession = true;
			this.emit({
				kind: 'session',
				sessionId: this.sessionId,
				model: this.model,
				cwd: this.projectDir
			});
		}
	}

	handleServerEvent(event, baseUrl, resolveIdle) {
		const props = event.properties ?? {};
		switch (event.type) {
			case 'message.updated': {
				// Track our own prompt's message id: its text part is echoed on
				// the part stream and must not be rendered as assistant output.
				const info = props.info ?? {};
				if (info.sessionID === this.sessionId && info.role === 'user' && info.id) {
					this.userMessageIds.add(info.id);
				}
				break;
			}
			case 'message.part.updated': {
				const part = props.part ?? {};
				if (part.sessionID === this.sessionId && !this.userMessageIds.has(part.messageID)) {
					this.handlePartUpdated(part);
				}
				break;
			}
			case 'message.part.delta': {
				if (props.sessionID === this.sessionId && props.field === 'text' && !this.userMessageIds.has(props.messageID)) {
					this.handleDelta(props);
				}
				break;
			}
			case 'session.idle': {
				if (props.sessionID === this.sessionId) {
					resolveIdle();
				}
				break;
			}
			case 'session.error': {
				if (props.sessionID && props.sessionID !== this.sessionId) {
					break;
				}
				const err = props.error;
				let message = 'opencode session error';
				if (err) {
					message = err.data && err.data.message ? String(err.data.message) : String(err.name ?? JSON.stringify(err));
				}
				this.emit({ kind: 'error', message });
				break;
			}
			case 'permission.asked': {
				if (props.sessionID !== this.sessionId || !props.id) {
					break;
				}
				const isEditGate = props.permission === 'edit';
				/** @type {Promise<'once' | 'always' | 'reject'>} */
				let decision;
				if (isEditGate) {
					// Our own pre-apply gate firing: the tool is blocked and
					// metadata.diff holds the exact pre-write old→new patch.
					const md = props.metadata ?? {};
					const callID = props.tool && props.tool.callID;
					const filepath = typeof md.filepath === 'string' ? md.filepath : undefined;
					const diff = typeof md.diff === 'string' && md.diff ? md.diff : undefined;
					if (callID && diff) {
						this.gateDiffs.set(callID, { filepath, diff });
					}
					// "once" so every subsequent edit asks again (each ask is a
					// fresh diff capture). The approval UI, if any, decides.
					decision = this.approveEdit
						? Promise.resolve(this.approveEdit({ filepath, patterns: props.patterns ?? [], diff, callID }))
							.then((r) => (r === 'reject' ? 'reject' : 'once'))
							.catch(() => 'once')
						: Promise.resolve('once');
					if (callID) {
						decision = decision.then((r) => {
							if (r === 'reject') {
								this.gateDiffs.delete(callID); // tool won't run; diff is moot
							}
							return r;
						});
					}
				} else {
					// Mirror non-interactive `opencode run`: don't stall the turn on
					// non-edit permission prompts.
					this.emit({ kind: 'status', status: `auto-approving permission: ${props.permission ?? ''} ${(props.patterns ?? []).join(', ')}` });
					decision = Promise.resolve('always');
				}
				decision.then((response) =>
					api(baseUrl, 'POST', `/session/${this.sessionId}/permissions/${props.id}`, {
						directory: this.projectDir,
						body: { response }
					})
				).catch((err) => {
					// A lost reply would leave the tool blocked; surface it.
					this.emit({ kind: 'error', message: `permission reply failed: ${String(err && err.message || err)}` });
				});
				break;
			}
			default:
				break;
		}
	}

	/** Token-level streaming for text and reasoning parts. */
	handleDelta(props) {
		const id = props.partID;
		const kind = this.partKinds.get(id) === 'reasoning' ? 'thinking-delta' : 'text-delta';
		const prev = this.textByPart.get(id) ?? '';
		this.textByPart.set(id, prev + (props.delta ?? ''));
		if (props.delta) {
			this.emit({ kind, text: props.delta, id });
		}
	}

	handlePartUpdated(part) {
		switch (part.type) {
			case 'text':
			case 'reasoning': {
				this.partKinds.set(part.id, part.type);
				// Reconcile against the accumulated delta text; emits anything the
				// delta stream missed (or the entire text if no deltas arrived).
				this.reconcileText(part);
				break;
			}
			case 'tool':
				this.handleToolPart(part);
				break;
			case 'step-finish': {
				if (!this.seenCostParts.has(part.id)) {
					this.seenCostParts.add(part.id);
					this.turnCost += typeof part.cost === 'number' ? part.cost : 0;
				}
				break;
			}
			default:
				break;
		}
	}

	reconcileText(part) {
		const id = part.id ?? 'anon';
		const full = typeof part.text === 'string' ? part.text : '';
		const prev = this.textByPart.get(id) ?? '';
		const delta = full.startsWith(prev) ? full.slice(prev.length) : (full === prev ? '' : full);
		if (full.length >= prev.length) {
			this.textByPart.set(id, full);
		}
		if (delta) {
			const kind = part.type === 'reasoning' ? 'thinking-delta' : 'text-delta';
			this.emit({ kind, text: delta, id });
		}
	}

	handleToolPart(part) {
		const callId = part.callID ?? part.id;
		if (!callId) {
			return;
		}
		const state = part.state ?? {};
		const status = state.status;

		// Wait for 'running' so the input args are complete (during 'pending'
		// they may still be streaming in).
		if ((status === 'running' || status === 'completed' || status === 'error') && !this.seenToolStart.has(callId)) {
			this.seenToolStart.add(callId);
			this.emit({
				kind: 'tool-start',
				id: callId,
				name: normalizeToolName(part.tool ?? 'tool'),
				rawName: part.tool ?? 'tool',
				input: state.input ?? {}
			});
		}

		if ((status === 'completed' || status === 'error') && !this.seenToolResult.has(callId)) {
			this.seenToolResult.add(callId);
			const content =
				typeof state.output === 'string'
					? state.output
					: state.error
						? String(state.error)
						: '';
			const rawName = part.tool ?? 'tool';
			const event = {
				kind: 'tool-result',
				id: callId,
				name: normalizeToolName(rawName),
				rawName,
				input: state.input ?? {},
				content,
				isError: status === 'error'
			};

			// Snapshot-on-read: a complete, lossless `read` gives us the file's
			// exact content at that moment. If the same file is later overwritten
			// by `write` (which provides no diff), the snapshot serves as the
			// "before" for the accept/reject diff.
			if (!event.isError && rawName === 'read') {
				const md = state.metadata ?? {};
				const input = state.input ?? {};
				if (md.truncated === false && typeof input.filePath === 'string') {
					const snapshot = parseReadToolOutput(content);
					if (snapshot !== null) {
						event.fileRead = { filePath: input.filePath, content: snapshot };
					}
				}
			}

			// For file-mutating tools, surface the data needed to reconstruct a
			// before/after diff for the chat editing UI (accept/reject pills) and
			// for inline ```diff rendering. opencode writes to disk eagerly, so
			// we capture:
			//   - filePath: the edited file
			//   - diff/patch: unified diffs (per-edit) to display and reverse-apply
			//   - newText: full new content (write only)
			//   - existedBefore: whether the file already existed (write)
		if (!event.isError && (rawName === 'edit' || rawName === 'patch' || rawName === 'write')) {
			const md = state.metadata ?? {};
			const input = state.input ?? {};
			const filediff = md.filediff && typeof md.filediff === 'object' ? md.filediff : undefined;
			const gate = this.gateDiffs.get(callId);
			event.fileEdit = {
				tool: rawName,
				filePath: input.filePath ?? (gate && gate.filepath),
				gateDiff: gate ? gate.diff : undefined,
					diff: typeof md.diff === 'string' ? md.diff : undefined,
					patch: filediff && typeof filediff.patch === 'string' ? filediff.patch : undefined,
					additions: filediff && typeof filediff.additions === 'number' ? filediff.additions : undefined,
					deletions: filediff && typeof filediff.deletions === 'number' ? filediff.deletions : undefined,
					oldString: typeof input.oldString === 'string' ? input.oldString : undefined,
					newString: typeof input.newString === 'string' ? input.newString : undefined,
					newText: typeof input.content === 'string' ? input.content : undefined,
					existedBefore: typeof md.exists === 'boolean' ? md.exists : undefined
				};
			}

			this.emit(event);
		}
	}
}

module.exports = { OpencodeDriver, normalizeToolName, splitModelId };
