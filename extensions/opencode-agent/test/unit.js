'use strict';
// Standalone unit tests for the pure file-edit helpers (no VS Code host).
// Run with: node test/unit.js

const assert = require('assert');
const {
	reconstructBeforeFromDiff,
	reconstructBefore,
	parseReadToolOutput,
	computeUnifiedDiff,
	displayDiff
} = require('../src/fileEdits');

// Mock the server module BEFORE opencode.js loads so driver tests can
// intercept REST calls without a live `opencode serve`.
const serverPath = require.resolve('../src/server');
const apiCalls = [];
let lastEventSink = null; // captured from subscribeEvents so tests can inject SSE events
require.cache[serverPath] = /** @type {any} */ ({
	id: serverPath,
	filename: serverPath,
	loaded: true,
	exports: {
		getServerUrl: async () => 'http://mock',
		api: async (_baseUrl, method, path, opts) => {
			apiCalls.push({ method, path, opts });
			return {};
		},
		subscribeEvents: async (_baseUrl, _directory, onEvent) => { lastEventSink = onEvent; },
		disposeServer: () => { }
	}
});
const { OpencodeDriver, splitModelId } = require('../src/opencode');
const {
	builtinPromptName,
	loadBuiltinPrompt,
	buildSystemPromptDoc,
	parseSystemPromptDoc,
	BASE_MARKER,
	EXTRA_MARKER
} = require('../src/systemPrompt');
const {
	truncateDiff,
	buildCommitMessages,
	cleanCommitMessage
} = require('../src/commitMessage');
const {
	buildRequestContext,
	langFor,
	isUri,
	isLocation,
	isBinaryData,
	relPath,
	parseTerminalAttachment
} = require('../src/context');
const { formatShellOutput, fenceFor } = require('../src/toolOutput');
const { formatTerminalSelection } = require('../src/terminalContext');
const { renderTodoList, todoSignature } = require('../src/todos');
const { suggestFollowups } = require('../src/followups');
const {
	clampContext,
	buildRequestBody,
	parseCompletion,
	cleanCompletion,
	isLanguageEnabled
} = require('../src/inlineCompletions');
const { parseRateLimit } = require('../src/rateLimit');

let failures = 0;
function test(name, fn) {
	try {
		fn();
		console.log(`  ok   ${name}`);
	} catch (err) {
		failures++;
		console.error(`  FAIL ${name}: ${err.message}`);
	}
}

/** @type {{ name: string, fn: () => Promise<void> }[]} */
const asyncTests = [];
function testAsync(name, fn) {
	asyncTests.push({ name, fn });
}

// ── parseReadToolOutput ───────────────────────────────────────────────────

function readOutput(lines, { total = lines.length, tail, path = '/tmp/x.txt' } = {}) {
	const body = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
	const end = tail ?? `(End of file - total ${total} lines)`;
	return `<path>${path}</path>\n<type>file</type>\n<content>\n${body}\n\n${end}\n</content>`;
}

test('parseReadToolOutput: complete read round-trips', () => {
	const out = readOutput(['alpha', 'beta', 'gamma']);
	assert.strictEqual(parseReadToolOutput(out), 'alpha\nbeta\ngamma\n');
});

test('parseReadToolOutput: real-world sample from opencode 1.15.10', () => {
	const out =
		'<path>/private/var/folders/T/tmp.x/notes.txt</path>\n<type>file</type>\n<content>\n' +
		'1: alpha\n2: beta\n3: gamma\n\n(End of file - total 3 lines)\n</content>';
	assert.strictEqual(parseReadToolOutput(out), 'alpha\nbeta\ngamma\n');
});

test('parseReadToolOutput: empty lines and colon-y content survive', () => {
	const out = readOutput(['', '5: tricky', '', 'x: y: z']);
	assert.strictEqual(parseReadToolOutput(out), '\n5: tricky\n\nx: y: z\n');
});

test('parseReadToolOutput: empty file', () => {
	const out = '<path>/tmp/x.txt</path>\n<type>file</type>\n<content>\n\n\n(End of file - total 0 lines)\n</content>';
	assert.strictEqual(parseReadToolOutput(out), '');
});

test('parseReadToolOutput: rejects partial reads (Showing lines tail)', () => {
	const out = readOutput(['a', 'b'], { tail: '(Showing lines 1-2 of 10. Use offset=3 to continue.)' });
	assert.strictEqual(parseReadToolOutput(out), null);
});

test('parseReadToolOutput: rejects byte-capped reads', () => {
	const out = readOutput(['a'], { tail: '(Output capped at 50 KB. Showing lines 1-1. Use offset=2 to continue.)' });
	assert.strictEqual(parseReadToolOutput(out), null);
});

test('parseReadToolOutput: rejects offset reads (numbering not 1-based)', () => {
	const out =
		'<path>/tmp/x.txt</path>\n<type>file</type>\n<content>\n' +
		'5: e\n6: f\n\n(End of file - total 2 lines)\n</content>';
	assert.strictEqual(parseReadToolOutput(out), null);
});

test('parseReadToolOutput: rejects truncated long lines', () => {
	const out = readOutput(['short', 'x'.repeat(50) + '... (line truncated to 2000 chars)']);
	assert.strictEqual(parseReadToolOutput(out), null);
});

test('parseReadToolOutput: rejects directory listings', () => {
	const out = '<path>/tmp</path>\n<type>directory</type>\n<entries>\na/\nb.txt\n\n(2 entries)\n</entries>';
	assert.strictEqual(parseReadToolOutput(out), null);
});

test('parseReadToolOutput: rejects garbage', () => {
	assert.strictEqual(parseReadToolOutput('Wrote file successfully.'), null);
	assert.strictEqual(parseReadToolOutput(undefined), null);
});

test('parseReadToolOutput: ignores trailing system-reminder', () => {
	const out = readOutput(['alpha']) + '\n\n<system-reminder>\nsomething\n</system-reminder>';
	assert.strictEqual(parseReadToolOutput(out), 'alpha\n');
});

// ── reconstructBefore: write + snapshot-on-read ───────────────────────────

test('reconstructBefore: overwrite write uses validated snapshot', () => {
	const edit = {
		tool: 'write',
		filePath: '/tmp/x.txt',
		newText: 'one\ntwo\nthree\n',
		existedBefore: true,
		snapshotBefore: 'alpha\nbeta\ngamma\n'
	};
	const result = reconstructBefore(edit, 'one\ntwo\nthree\n');
	assert.ok(result);
	assert.strictEqual(result.before, 'alpha\nbeta\ngamma\n');
});

test('reconstructBefore: snapshot rejected when disk does not match write content', () => {
	const edit = {
		tool: 'write',
		filePath: '/tmp/x.txt',
		newText: 'one\ntwo\nthree\n',
		existedBefore: true,
		snapshotBefore: 'alpha\n'
	};
	assert.strictEqual(reconstructBefore(edit, 'something else entirely'), null);
});

test('reconstructBefore: overwrite without snapshot stays non-reconstructable', () => {
	const edit = { tool: 'write', filePath: '/tmp/x.txt', newText: 'new\n', existedBefore: true };
	assert.strictEqual(reconstructBefore(edit, 'new\n'), null);
});

test('reconstructBefore: new-file write has empty before', () => {
	const edit = { tool: 'write', filePath: '/tmp/x.txt', newText: 'new\n', existedBefore: false };
	assert.deepStrictEqual(reconstructBefore(edit, 'new\n'), { before: '' });
});

// ── reconstructBefore: pre-apply gate diff (blind writes) ─────────────────

// Real shape from opencode 1.15.10's permission.asked metadata.diff.
const GATE_DIFF = [
	'Index: /private/tmp/oc-gate-test/notes.txt',
	'===================================================================',
	'--- /private/tmp/oc-gate-test/notes.txt',
	'+++ /private/tmp/oc-gate-test/notes.txt',
	'@@ -1,3 +1,3 @@',
	'-alpha',
	'-beta',
	'-gamma',
	'+one',
	'+two',
	'+three',
	''
].join('\n');

test('reconstructBefore: blind overwrite recovered via gate diff', () => {
	const edit = {
		tool: 'write',
		filePath: '/tmp/notes.txt',
		newText: 'one\ntwo\nthree\n',
		existedBefore: true,
		gateDiff: GATE_DIFF
	};
	const result = reconstructBefore(edit, 'one\ntwo\nthree\n');
	assert.ok(result);
	assert.strictEqual(result.before, 'alpha\nbeta\ngamma\n');
});

test('reconstructBefore: stale gate diff falls back to snapshot', () => {
	const edit = {
		tool: 'write',
		filePath: '/tmp/notes.txt',
		newText: 'changed since\n',
		existedBefore: true,
		gateDiff: GATE_DIFF, // does not match afterText -> rejected
		snapshotBefore: 'old content\n'
	};
	const result = reconstructBefore(edit, 'changed since\n');
	assert.ok(result);
	assert.strictEqual(result.before, 'old content\n');
});

test('reconstructBefore: edit falls back to gate diff when metadata diff is unusable', () => {
	const edit = {
		tool: 'edit',
		filePath: '/tmp/notes.txt',
		diff: '@@ -1,1 +1,1 @@\n-nope\n+mismatch',
		gateDiff: GATE_DIFF
	};
	const result = reconstructBefore(edit, 'one\ntwo\nthree\n');
	assert.ok(result);
	assert.strictEqual(result.before, 'alpha\nbeta\ngamma\n');
});

// ── reconstructBeforeFromDiff (regression coverage) ───────────────────────

test('reconstructBeforeFromDiff: simple hunk reverses cleanly', () => {
	const after = 'alpha\nBETA\ngamma\n';
	const diff = [
		'--- a/x.txt',
		'+++ b/x.txt',
		'@@ -1,3 +1,3 @@',
		' alpha',
		'-beta',
		'+BETA',
		' gamma'
	].join('\n');
	assert.strictEqual(reconstructBeforeFromDiff(after, diff), 'alpha\nbeta\ngamma\n');
});

test('reconstructBeforeFromDiff: mismatched diff returns null', () => {
	const diff = '@@ -1,1 +1,1 @@\n-old\n+new';
	assert.strictEqual(reconstructBeforeFromDiff('does not match\n', diff), null);
});

// ── computeUnifiedDiff ────────────────────────────────────────────────────
// Oracle: reverse-applying the generated diff to `after` must recover `before`.

function roundTrip(before, after) {
	const diff = computeUnifiedDiff(before, after);
	if (before === after) {
		assert.strictEqual(diff, '');
		return;
	}
	assert.ok(diff.includes('@@'), 'diff has hunk header');
	assert.strictEqual(reconstructBeforeFromDiff(after, diff), before);
}

test('computeUnifiedDiff: simple line change round-trips', () => {
	roundTrip('alpha\nbeta\ngamma\n', 'alpha\nBETA\ngamma\n');
});

test('computeUnifiedDiff: insertion and deletion round-trips', () => {
	roundTrip('a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nX\nc\ne\nf\nY\ng\nh\n');
});

test('computeUnifiedDiff: multiple distant hunks round-trip', () => {
	const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
	const after = before.replace('line 3', 'LINE 3').replace('line 30', 'LINE 30');
	const diff = computeUnifiedDiff(before, after);
	assert.strictEqual((diff.match(/^@@ /gm) || []).length, 2, 'two hunks');
	assert.strictEqual(reconstructBeforeFromDiff(after, diff), before);
});

test('computeUnifiedDiff: full rewrite round-trips', () => {
	roundTrip('one\ntwo\nthree\n', 'totally\ndifferent\ncontent\nhere\n');
});

test('computeUnifiedDiff: equal inputs give empty diff', () => {
	roundTrip('same\n', 'same\n');
});

// ── displayDiff ───────────────────────────────────────────────────────────

test('displayDiff: prefers provided filediff patch and strips headers', () => {
	const edit = {
		tool: 'edit',
		patch: 'Index: x\n===\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n'
	};
	assert.strictEqual(displayDiff(edit), '@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma');
});

test('displayDiff: new-file write renders all-added', () => {
	const edit = { tool: 'write', newText: 'one\ntwo\n', existedBefore: false };
	assert.strictEqual(displayDiff(edit), '+one\n+two');
});

test('displayDiff: overwrite with snapshot computes diff', () => {
	const edit = {
		tool: 'write',
		newText: 'one\ntwo\nthree\n',
		existedBefore: true,
		snapshotBefore: 'one\nTWO\nthree\n'
	};
	const result = displayDiff(edit);
	assert.ok(result.includes('-TWO'));
	assert.ok(result.includes('+two'));
});

test('displayDiff: blind overwrite gives null without gate diff', () => {
	const edit = { tool: 'write', newText: 'x\n', existedBefore: true };
	assert.strictEqual(displayDiff(edit), null);
});

test('displayDiff: blind overwrite renders gate diff with headers stripped', () => {
	const edit = { tool: 'write', newText: 'one\ntwo\nthree\n', existedBefore: true, gateDiff: GATE_DIFF };
	assert.strictEqual(
		displayDiff(edit),
		'@@ -1,3 +1,3 @@\n-alpha\n-beta\n-gamma\n+one\n+two\n+three'
	);
});

test('displayDiff: long diffs are capped', () => {
	const before = Array.from({ length: 500 }, (_, i) => `a${i}`).join('\n') + '\n';
	const edit = { tool: 'write', newText: before.toUpperCase(), existedBefore: true, snapshotBefore: before };
	const result = displayDiff(edit);
	assert.ok(result.split('\n').length <= 301);
	assert.ok(result.endsWith('more lines not shown @@'));
});

// ── splitModelId ──────────────────────────────────────────────────────────

test('splitModelId: provider is the first segment only', () => {
	assert.deepStrictEqual(
		splitModelId('frontier/anthropic/claude-sonnet-4.6'),
		{ providerID: 'frontier', modelID: 'anthropic/claude-sonnet-4.6' }
	);
	assert.deepStrictEqual(
		splitModelId('opencode/big-pickle'),
		{ providerID: 'opencode', modelID: 'big-pickle' }
	);
	assert.strictEqual(splitModelId('nomodel'), undefined);
});

// ── systemPrompt: built-in selection + doc round-trip ─────────────────────

test('builtinPromptName: mirrors SystemPrompt.provider()', () => {
	assert.strictEqual(builtinPromptName('claude-sonnet-4.6'), 'anthropic');
	assert.strictEqual(builtinPromptName('gpt-4.1'), 'beast');
	assert.strictEqual(builtinPromptName('o1-mini'), 'beast');
	assert.strictEqual(builtinPromptName('gpt-5.5-codex'), 'codex');
	assert.strictEqual(builtinPromptName('gpt-5.5'), 'gpt');
	assert.strictEqual(builtinPromptName('gemini-2.5-pro'), 'gemini');
	assert.strictEqual(builtinPromptName('Trinity-large'), 'trinity');
	assert.strictEqual(builtinPromptName('kimi-k2'), 'kimi');
	assert.strictEqual(builtinPromptName('big-pickle'), 'default');
	assert.strictEqual(builtinPromptName(''), 'default');
});

test('loadBuiltinPrompt: vendored prompts exist for every selectable name', () => {
	for (const name of ['anthropic', 'beast', 'codex', 'default', 'gemini', 'gpt', 'kimi', 'trinity']) {
		const text = loadBuiltinPrompt(name);
		assert.ok(text && text.length > 100, `missing or too short: ${name}`);
	}
	assert.strictEqual(loadBuiltinPrompt('nope'), null);
});

test('systemPrompt doc: build/parse round-trips', () => {
	const base = 'You are OpenCode.\n\nDo good work.';
	const extras = 'Always answer in haiku.\n\nUse tabs.';
	const doc = buildSystemPromptDoc({ baseLabel: 'built-in "anthropic"', baseText: base, extras });
	const parsed = parseSystemPromptDoc(doc);
	assert.ok(parsed);
	assert.strictEqual(parsed.base, base);
	assert.strictEqual(parsed.extras, extras);
});

test('systemPrompt doc: empty extras round-trip', () => {
	const doc = buildSystemPromptDoc({ baseLabel: 'x', baseText: 'base', extras: '' });
	const parsed = parseSystemPromptDoc(doc);
	assert.ok(parsed);
	assert.strictEqual(parsed.base, 'base');
	assert.strictEqual(parsed.extras, '');
});

test('systemPrompt doc: parse rejects missing/reordered/duplicated markers', () => {
	const doc = buildSystemPromptDoc({ baseLabel: 'x', baseText: 'base', extras: 'extras' });
	assert.strictEqual(parseSystemPromptDoc(doc.replace(BASE_MARKER, '')), null);
	assert.strictEqual(parseSystemPromptDoc(doc.replace(EXTRA_MARKER, '')), null);
	assert.strictEqual(parseSystemPromptDoc(`${EXTRA_MARKER}\nextras\n${BASE_MARKER}\nbase`), null);
	assert.strictEqual(parseSystemPromptDoc(doc + '\n' + EXTRA_MARKER), null);
});

test('systemPrompt doc: edited sections parse back', () => {
	const doc = buildSystemPromptDoc({ baseLabel: 'x', baseText: 'old base', extras: 'old extras' });
	const edited = doc.replace('old base', 'new base\nwith lines').replace('old extras', 'new extras');
	const parsed = parseSystemPromptDoc(edited);
	assert.ok(parsed);
	assert.strictEqual(parsed.base, 'new base\nwith lines');
	assert.strictEqual(parsed.extras, 'new extras');
});

// ── commitMessage: prompt building + response cleanup ─────────────────────

test('truncateDiff: short diffs pass through, long ones are capped', () => {
	assert.strictEqual(truncateDiff('short', 100), 'short');
	const long = 'x'.repeat(500);
	const result = truncateDiff(long, 100);
	assert.ok(result.length < 200);
	assert.ok(result.endsWith('[... diff truncated ...]'));
});

test('buildCommitMessages: includes diff, subjects, and untracked files', () => {
	const messages = buildCommitMessages({
		diff: '+++ b/a.js\n+hello',
		recentSubjects: ['fix: thing', 'feat: stuff'],
		untracked: ['new.txt']
	});
	assert.strictEqual(messages.length, 2);
	assert.strictEqual(messages[0].role, 'system');
	assert.ok(messages[0].content.includes('imperative'));
	const user = messages[1].content;
	assert.ok(user.includes('- fix: thing'));
	assert.ok(user.includes('- new.txt'));
	assert.ok(user.includes('+hello'));
});

test('buildCommitMessages: omits empty sections', () => {
	const user = buildCommitMessages({ diff: '+x' })[1].content;
	assert.ok(!user.includes('Recent commit subjects'));
	assert.ok(!user.includes('untracked'));
});

test('cleanCommitMessage: strips fences, quotes, and prefixes', () => {
	assert.strictEqual(cleanCommitMessage('```\nfix: a thing\n```'), 'fix: a thing');
	assert.strictEqual(cleanCommitMessage('```text\nfix: a thing\nbody line\n```'), 'fix: a thing\nbody line');
	assert.strictEqual(cleanCommitMessage('"fix: a thing"'), 'fix: a thing');
	assert.strictEqual(cleanCommitMessage('Commit message: fix: a thing'), 'fix: a thing');
	assert.strictEqual(cleanCommitMessage('  fix: a thing \n'), 'fix: a thing');
	assert.strictEqual(cleanCommitMessage(''), '');
	assert.strictEqual(cleanCommitMessage(null), '');
});

// ── OpencodeDriver question handling (mocked server) ─────────────────────

/** Let queued promise chains drain. */
async function settle() {
	for (let i = 0; i < 5; i++) {
		await new Promise((resolve) => setImmediate(resolve));
	}
}

function makeDriver(askQuestion) {
	const events = [];
	const driver = new OpencodeDriver((e) => events.push(e), { askQuestion });
	driver.sessionId = 'ses_test';
	return { driver, events };
}

const QUESTION_EVENT = {
	type: 'question.asked',
	properties: {
		id: 'que_1',
		sessionID: 'ses_test',
		questions: [{
			header: 'Approach',
			question: 'Which approach should I take?',
			options: [
				{ label: 'Option A', description: 'first' },
				{ label: 'Option B', description: 'second' }
			]
		}]
	}
};

testAsync('question.asked: valid answers are replied', async () => {
	apiCalls.length = 0;
	const { driver } = makeDriver(async (req) => {
		assert.strictEqual(req.id, 'que_1');
		assert.strictEqual(req.questions.length, 1);
		assert.strictEqual(req.questions[0].header, 'Approach');
		return [['Option A']];
	});
	driver.handleServerEvent(QUESTION_EVENT, 'http://mock', () => { });
	await settle();
	assert.strictEqual(apiCalls.length, 1);
	assert.strictEqual(apiCalls[0].path, '/question/que_1/reply');
	assert.deepStrictEqual(apiCalls[0].opts.body, { answers: [['Option A']] });
	assert.strictEqual(driver.pendingQuestionIds.size, 0);
});

testAsync('question.asked: null answer rejects', async () => {
	apiCalls.length = 0;
	const { driver } = makeDriver(async () => null);
	driver.handleServerEvent(QUESTION_EVENT, 'http://mock', () => { });
	await settle();
	assert.strictEqual(apiCalls.length, 1);
	assert.strictEqual(apiCalls[0].path, '/question/que_1/reject');
});

testAsync('question.asked: wrong answer count rejects', async () => {
	apiCalls.length = 0;
	const { driver } = makeDriver(async () => [['A'], ['B']]); // 2 answers, 1 question
	driver.handleServerEvent(QUESTION_EVENT, 'http://mock', () => { });
	await settle();
	assert.strictEqual(apiCalls.length, 1);
	assert.strictEqual(apiCalls[0].path, '/question/que_1/reject');
});

testAsync('question.asked: callback throw rejects (turn never hangs)', async () => {
	apiCalls.length = 0;
	const { driver } = makeDriver(async () => { throw new Error('ui broke'); });
	driver.handleServerEvent(QUESTION_EVENT, 'http://mock', () => { });
	await settle();
	assert.strictEqual(apiCalls.length, 1);
	assert.strictEqual(apiCalls[0].path, '/question/que_1/reject');
});

testAsync('question.asked: no callback rejects', async () => {
	apiCalls.length = 0;
	const { driver } = makeDriver(undefined);
	driver.handleServerEvent(QUESTION_EVENT, 'http://mock', () => { });
	await settle();
	assert.strictEqual(apiCalls.length, 1);
	assert.strictEqual(apiCalls[0].path, '/question/que_1/reject');
});

testAsync('question.asked: other sessions are ignored', async () => {
	apiCalls.length = 0;
	const { driver } = makeDriver(async () => [['Option A']]);
	driver.handleServerEvent({
		...QUESTION_EVENT,
		properties: { ...QUESTION_EVENT.properties, sessionID: 'ses_other' }
	}, 'http://mock', () => { });
	await settle();
	assert.strictEqual(apiCalls.length, 0);
});

testAsync('interrupt rejects pending questions and skips the late reply', async () => {
	apiCalls.length = 0;
	let resolveAnswer;
	const { driver } = makeDriver(() => new Promise((resolve) => { resolveAnswer = resolve; }));
	driver.handleServerEvent(QUESTION_EVENT, 'http://mock', () => { });
	await settle();
	assert.strictEqual(apiCalls.length, 0); // still waiting on the user

	driver.interrupt();
	await settle();
	const paths = apiCalls.map((c) => c.path);
	assert.ok(paths.includes('/question/que_1/reject'), `expected reject, got ${paths}`);
	assert.ok(paths.includes('/session/ses_test/abort'), `expected abort, got ${paths}`);

	// The user answers after the interrupt: must not double-reply.
	resolveAnswer([['Option A']]);
	await settle();
	assert.ok(!apiCalls.some((c) => c.path === '/question/que_1/reply'));
});

testAsync('send: system prompt rides along in the message body', async () => {
	apiCalls.length = 0;
	const { driver } = makeDriver(undefined);
	driver.configure({ systemPrompt: 'Always answer in haiku.' });
	const turn = driver.send('hello');
	await settle();
	// End the turn via the SSE stream like the real server would.
	lastEventSink({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
	await turn;
	const post = apiCalls.find((c) => c.path === '/session/ses_test/message');
	assert.ok(post, 'message POST not found');
	assert.strictEqual(post.opts.body.system, 'Always answer in haiku.');
});

testAsync('send: no system field when no prompt configured', async () => {
	apiCalls.length = 0;
	const { driver } = makeDriver(undefined);
	const turn = driver.send('hello');
	await settle();
	lastEventSink({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
	await turn;
	const post = apiCalls.find((c) => c.path === '/session/ses_test/message');
	assert.ok(post, 'message POST not found');
	assert.strictEqual('system' in post.opts.body, false);
});

testAsync('send: assistant tokens and cost surface on turn-complete', async () => {
	apiCalls.length = 0;
	const { driver, events } = makeDriver(undefined);
	const turn = driver.send('hello');
	await settle();
	const tokens = { input: 1000, output: 200, reasoning: 50, cache: { read: 5000, write: 100 } };
	// Cost lives on the assistant message (cumulative across its steps), the same
	// place as tokens. Emit two updates for the same message to prove the latest
	// (cumulative) value wins rather than double-counting.
	lastEventSink({
		type: 'message.updated',
		properties: { info: { sessionID: 'ses_test', role: 'assistant', id: 'msg_a', tokens, cost: 0.001 } }
	});
	lastEventSink({
		type: 'message.updated',
		properties: { info: { sessionID: 'ses_test', role: 'assistant', id: 'msg_a', tokens, cost: 0.0034 } }
	});
	lastEventSink({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
	await turn;
	const complete = events.find((e) => e.kind === 'turn-complete');
	assert.ok(complete, 'turn-complete not emitted');
	assert.deepStrictEqual({ tokens: complete.tokens, costUsd: complete.costUsd }, { tokens, costUsd: 0.0034 });
});

// ── context (attached references) ─────────────────────────────────────────

test('context: type guards distinguish uri / location / binary', () => {
	const uri = { scheme: 'file', path: '/p/a.ts', fsPath: '/p/a.ts' };
	const loc = { uri, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } } };
	const bin = { mimeType: 'image/png', data: async () => new Uint8Array() };
	assert.ok(isUri(uri) && !isLocation(uri) && !isBinaryData(uri));
	assert.ok(isLocation(loc) && !isUri(loc));
	assert.ok(isBinaryData(bin) && !isUri(bin) && !isLocation(bin));
});

test('context: langFor maps extensions, relPath strips project dir', () => {
	assert.strictEqual(langFor('src/x.tsx'), 'typescript');
	assert.strictEqual(langFor('a.unknownext'), '');
	assert.strictEqual(relPath('/proj/src/a.ts', '/proj'), 'src/a.ts');
	assert.strictEqual(relPath('/other/a.ts', '/proj'), '/other/a.ts');
});

function fakeFs(files = {}, dirs = {}, bytes = {}) {
	return {
		async stat(p) {
			if (dirs[p]) {
				return 'directory';
			}
			if (p in files || p in bytes) {
				return 'file';
			}
			return 'unknown';
		},
		async readText(p) {
			if (!(p in files)) {
				throw new Error('ENOENT');
			}
			return files[p];
		},
		async readBytes(p) {
			if (!(p in bytes)) {
				throw new Error('ENOENT');
			}
			return bytes[p];
		},
		async list(p) { return dirs[p] || []; }
	};
}

testAsync('context: empty references produce no context', async () => {
	const { contextText, fileParts } = await buildRequestContext([], { projectDir: '/proj' });
	assert.strictEqual(contextText, '');
	assert.deepStrictEqual(fileParts, []);
});

testAsync('context: a file reference is inlined as a fenced block', async () => {
	const fs = fakeFs({ '/proj/src/a.ts': 'export const x = 1;\n' });
	const refs = [{ id: 'f', value: { scheme: 'file', path: '/proj/src/a.ts', fsPath: '/proj/src/a.ts' } }];
	const { contextText, summary } = await buildRequestContext(refs, { projectDir: '/proj', fs });
	assert.ok(contextText.includes('File: src/a.ts'), contextText);
	assert.ok(contextText.includes('```typescript'), contextText);
	assert.ok(contextText.includes('export const x = 1;'), contextText);
	assert.ok(summary.includes('src/a.ts'), summary);
});

testAsync('context: a selection inlines only the ranged lines', async () => {
	const fs = fakeFs({ '/proj/a.js': 'l1\nl2\nl3\nl4\nl5\n' });
	const uri = { scheme: 'file', path: '/proj/a.js', fsPath: '/proj/a.js' };
	const refs = [{ id: 's', value: { uri, range: { start: { line: 1, character: 0 }, end: { line: 2, character: 3 } } } }];
	const { contextText } = await buildRequestContext(refs, { projectDir: '/proj', fs });
	assert.ok(contextText.includes('Selection from a.js (lines 2–3)'), contextText);
	assert.ok(contextText.includes('l2\nl3'), contextText);
	assert.ok(!contextText.includes('l1'), contextText);
	assert.ok(!contextText.includes('l4'), contextText);
});

testAsync('context: selection ending at column 0 drops the trailing line', async () => {
	const fs = fakeFs({ '/proj/a.js': 'l1\nl2\nl3\n' });
	const uri = { scheme: 'file', path: '/proj/a.js', fsPath: '/proj/a.js' };
	const refs = [{ id: 's', value: { uri, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } } } }];
	const { contextText } = await buildRequestContext(refs, { projectDir: '/proj', fs });
	assert.ok(contextText.includes('lines 1–2'), contextText);
	assert.ok(!contextText.includes('l3'), contextText);
});

testAsync('context: a folder reference lists its entries', async () => {
	const fs = fakeFs({}, { '/proj/src': ['a.ts', 'b.ts', 'sub/'] });
	const refs = [{ id: 'd', value: { scheme: 'file', path: '/proj/src', fsPath: '/proj/src' } }];
	const { contextText } = await buildRequestContext(refs, { projectDir: '/proj', fs });
	assert.ok(contextText.includes('Folder: src/'), contextText);
	assert.ok(contextText.includes('- a.ts'), contextText);
	assert.ok(contextText.includes('- sub/'), contextText);
});

testAsync('context: an image becomes a data-url file part, not text', async () => {
	const bytes = new Uint8Array([1, 2, 3, 4]);
	const refs = [{ id: 'img', value: { mimeType: 'image/png', data: async () => bytes } }];
	const { contextText, fileParts } = await buildRequestContext(refs, { projectDir: '/proj' });
	assert.strictEqual(contextText, '');
	assert.strictEqual(fileParts.length, 1);
	assert.strictEqual(fileParts[0].type, 'file');
	assert.strictEqual(fileParts[0].mime, 'image/png');
	assert.ok(fileParts[0].url.startsWith('data:image/png;base64,'), fileParts[0].url);
	assert.strictEqual(fileParts[0].url, 'data:image/png;base64,' + Buffer.from(bytes).toString('base64'));
});

testAsync('context: an attached image file is forwarded as a media part', async () => {
	const bytes = new Uint8Array([137, 80, 78, 71]); // PNG magic-ish
	const fs = fakeFs({}, {}, { '/proj/shot.png': bytes });
	const refs = [{ id: 'img', value: { scheme: 'file', path: '/proj/shot.png', fsPath: '/proj/shot.png' } }];
	const { contextText, fileParts } = await buildRequestContext(refs, { projectDir: '/proj', fs });
	assert.strictEqual(contextText, ''); // not inlined as a text note anymore
	assert.strictEqual(fileParts.length, 1);
	assert.strictEqual(fileParts[0].type, 'file');
	assert.strictEqual(fileParts[0].mime, 'image/png');
	assert.strictEqual(fileParts[0].filename, 'shot.png');
	assert.strictEqual(fileParts[0].url, 'data:image/png;base64,' + Buffer.from(bytes).toString('base64'));
});

testAsync('context: non-image binary is skipped', async () => {
	const refs = [{ id: 'b', value: { mimeType: 'application/zip', data: async () => new Uint8Array([0]) } }];
	const { contextText, fileParts } = await buildRequestContext(refs, { projectDir: '/proj' });
	assert.strictEqual(contextText, '');
	assert.strictEqual(fileParts.length, 0);
});

testAsync('context: a bad reference is skipped, others survive', async () => {
	const fs = fakeFs({ '/proj/ok.ts': 'ok\n' });
	const refs = [
		{ id: 'missing', value: { scheme: 'file', path: '/proj/missing.ts', fsPath: '/proj/missing.ts' } },
		{ id: 'ok', value: { scheme: 'file', path: '/proj/ok.ts', fsPath: '/proj/ok.ts' } }
	];
	const { contextText } = await buildRequestContext(refs, { projectDir: '/proj', fs });
	assert.ok(contextText.includes('could not be read'), contextText);
	assert.ok(contextText.includes('File: ok.ts'), contextText);
});

testAsync('context: a terminal-command attachment is rendered nicely', async () => {
	const refs = [{ id: 'terminalCommand:1', value: 'Command: npm test\nOutput:\nFAIL foo\nExit Code: 1' }];
	const { contextText, summary } = await buildRequestContext(refs, { projectDir: '/proj' });
	assert.ok(contextText.includes('Terminal command (exit 1)'), contextText);
	assert.ok(contextText.includes('npm test'), contextText);
	assert.ok(contextText.includes('FAIL foo'), contextText);
	assert.ok(summary.includes('terminal: npm test'), summary);
});

testAsync('context: send forwards context and file parts on the message body', async () => {
	apiCalls.length = 0;
	const { driver } = makeDriver(undefined);
	const turn = driver.send('do the thing', {
		contextText: 'attached stuff',
		fileParts: [{ type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA' }]
	});
	await settle();
	lastEventSink({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
	await turn;
	const post = apiCalls.find((c) => c.path === '/session/ses_test/message');
	assert.ok(post, 'message POST not found');
	const parts = post.opts.body.parts;
	assert.strictEqual(parts[0].text, 'attached stuff');
	assert.strictEqual(parts[1].type, 'file');
	assert.strictEqual(parts[parts.length - 1].text, 'do the thing');
});

// ── todos (live checklist) ────────────────────────────────────────────────

test('todos: renders checkbox states with a progress count', () => {
	const md = renderTodoList([
		{ content: 'Set up scaffolding', status: 'completed' },
		{ content: 'Wire the handler', status: 'in_progress' },
		{ content: 'Write tests', status: 'pending' },
		{ content: 'Drop legacy path', status: 'cancelled' }
	]);
	assert.ok(md.includes('**Todos · 1/4**'), md);
	assert.ok(md.includes('- [x] Set up scaffolding'), md);
	assert.ok(md.includes('- [ ] Wire the handler _(in progress)_'), md);
	assert.ok(md.includes('- [ ] Write tests'), md);
	assert.ok(md.includes('- [x] ~~Drop legacy path~~'), md);
});

test('todos: empty or content-less lists render nothing', () => {
	assert.strictEqual(renderTodoList([]), '');
	assert.strictEqual(renderTodoList(undefined), '');
	assert.strictEqual(renderTodoList([{ status: 'pending', content: '   ' }]), '');
});

test('todos: signature changes only on meaningful updates', () => {
	const a = [{ content: 'A', status: 'pending' }, { content: 'B', status: 'pending' }];
	const b = [{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }];
	assert.strictEqual(todoSignature(a), todoSignature([{ content: 'A' }, { content: 'B' }]));
	assert.notStrictEqual(todoSignature(a), todoSignature(b));
});

test('todos: tolerates alternate field names and in-progress spelling', () => {
	const md = renderTodoList([{ text: 'Legacy text field', status: 'in-progress' }]);
	assert.ok(md.includes('- [ ] Legacy text field _(in progress)_'), md);
});

// ── follow-up suggestions ─────────────────────────────────────────────────

test('followups: plan mode suggests implementing the plan', () => {
	const f = suggestFollowups({ mode: 'plan' });
	assert.ok(f.length >= 1 && f.length <= 3);
	assert.ok(f.some((x) => /implement this plan/i.test(x.label)), JSON.stringify(f));
});

test('followups: edited files suggest review and tests', () => {
	const f = suggestFollowups({ filesEdited: 3 });
	const labels = f.map((x) => x.label).join(' | ');
	assert.ok(/review the changes/i.test(labels), labels);
	assert.ok(/tests/i.test(labels), labels);
	assert.ok(f.every((x) => typeof x.prompt === 'string' && x.prompt.length > 0));
});

test('followups: errors suggest a different approach first', () => {
	const f = suggestFollowups({ hadError: true, filesEdited: 1 });
	assert.ok(/different approach/i.test(f[0].label), JSON.stringify(f));
	assert.ok(f.length <= 3);
});

test('followups: a plain answer suggests acting on it', () => {
	const f = suggestFollowups({ filesEdited: 0, hadError: false });
	const labels = f.map((x) => x.label).join(' | ');
	assert.ok(/make these changes/i.test(labels), labels);
});

test('followups: missing metadata never throws and is capped at three', () => {
	assert.ok(Array.isArray(suggestFollowups()));
	assert.ok(suggestFollowups({}).length <= 3);
	assert.ok(suggestFollowups({ hadError: true, filesEdited: 5 }).length <= 3);
});

// ── inline completions (pure helpers) ─────────────────────────────────────

test('completions: clampContext keeps prefix tail and suffix head', () => {
	const { prefix, suffix } = clampContext('abcdefgh', '12345678', 3, 4);
	assert.strictEqual(prefix, 'fgh');
	assert.strictEqual(suffix, '1234');
});

test('completions: clampContext leaves short context untouched', () => {
	const { prefix, suffix } = clampContext('ab', 'cd', 10, 10);
	assert.strictEqual(prefix, 'ab');
	assert.strictEqual(suffix, 'cd');
});

test('completions: buildRequestBody openai uses prompt + suffix', () => {
	const body = buildRequestBody('openai', { prefix: 'foo(', suffix: ')', model: 'm', maxTokens: 64 });
	assert.strictEqual(body.prompt, 'foo(');
	assert.strictEqual(body.suffix, ')');
	assert.strictEqual(body.max_tokens, 64);
	assert.strictEqual(body.model, 'm');
	assert.strictEqual(body.stream, false);
});

test('completions: buildRequestBody omits model when empty', () => {
	const body = buildRequestBody('openai', { prefix: 'a', suffix: 'b' });
	assert.ok(!('model' in body));
	assert.strictEqual(body.max_tokens, 128);
});

test('completions: buildRequestBody llama uses infill fields', () => {
	const body = buildRequestBody('llama', { prefix: 'a', suffix: 'b', maxTokens: 32 });
	assert.strictEqual(body.input_prefix, 'a');
	assert.strictEqual(body.input_suffix, 'b');
	assert.strictEqual(body.n_predict, 32);
	assert.ok(!('prompt' in body));
});

test('completions: parseCompletion reads openai and llama shapes', () => {
	assert.strictEqual(parseCompletion('openai', { choices: [{ text: 'hi' }] }), 'hi');
	assert.strictEqual(parseCompletion('openai', { choices: [{ message: { content: 'yo' } }] }), 'yo');
	assert.strictEqual(parseCompletion('llama', { content: 'sup' }), 'sup');
	assert.strictEqual(parseCompletion('openai', {}), '');
	assert.strictEqual(parseCompletion('llama', null), '');
});

test('completions: cleanCompletion trims overlap with the suffix', () => {
	// Model regurgitated the closing paren that already follows the cursor.
	assert.strictEqual(cleanCompletion('bar())', ')', 1000), 'bar()');
	assert.strictEqual(cleanCompletion('x = 1\n}', '\n}', 1000), 'x = 1');
});

test('completions: cleanCompletion drops whitespace-only and caps length', () => {
	assert.strictEqual(cleanCompletion('   \n  ', ''), '');
	assert.strictEqual(cleanCompletion('abcdef', '', 3), 'abc');
});

test('completions: isLanguageEnabled respects the disabled list', () => {
	assert.strictEqual(isLanguageEnabled('typescript', []), true);
	assert.strictEqual(isLanguageEnabled('markdown', ['markdown', 'plaintext']), false);
	assert.strictEqual(isLanguageEnabled('TypeScript', ['typescript']), false); // case-insensitive
	assert.strictEqual(isLanguageEnabled('python', ['markdown']), true);
});

// ── rate-limit parsing ────────────────────────────────────────────────────

test('ratelimit: detects common signals', () => {
	assert.strictEqual(parseRateLimit('Error 429: Too Many Requests').limited, true);
	assert.strictEqual(parseRateLimit('rate limit exceeded').limited, true);
	assert.strictEqual(parseRateLimit('Anthropic API is overloaded (529)').limited, true);
	assert.strictEqual(parseRateLimit('insufficient_quota').limited, true);
	assert.strictEqual(parseRateLimit('TypeError: undefined is not a function').limited, false);
	assert.strictEqual(parseRateLimit('').limited, false);
});

test('ratelimit: extracts retry-after seconds and minutes', () => {
	assert.strictEqual(parseRateLimit('rate limit; retry-after: 30').retryAfterSec, 30);
	assert.strictEqual(parseRateLimit('429 please try again in 2 minutes').retryAfterSec, 120);
	assert.strictEqual(parseRateLimit('rate limited, retry after 15 seconds').retryAfterSec, 15);
	assert.strictEqual(parseRateLimit('rate limit hit').retryAfterSec, null);
});

// ── shell output rendering ────────────────────────────────────────────────

test('toolOutput: empty success output renders nothing, failure notes it', () => {
	assert.strictEqual(formatShellOutput('', { isError: false }), '');
	assert.strictEqual(formatShellOutput('   \n ', { isError: false }), '');
	assert.match(formatShellOutput('', { isError: true }), /Command failed \(no output\)/);
});

test('toolOutput: renders output in a fenced block with a label', () => {
	const md = formatShellOutput('hello\nworld', { isError: false });
	assert.match(md, /\*\*Output\*\*/);
	assert.match(md, /hello\nworld/);
	const fail = formatShellOutput('boom', { isError: true });
	assert.match(fail, /\*\*Output \(failed\)\*\*/);
});

test('toolOutput: tail-caps long output and notes the omission', () => {
	const lines = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
	const md = formatShellOutput(lines, { maxLines: 40 });
	assert.match(md, /last 40 of 100 lines/);
	assert.ok(md.includes('line99'), 'keeps the tail');
	assert.ok(!md.includes('line0\n'), 'drops the head');
});

test('toolOutput: fenceFor avoids breaking on backticks in output', () => {
	assert.strictEqual(fenceFor('no backticks'), '```');
	assert.strictEqual(fenceFor('a ``` b'), '````');
	const md = formatShellOutput('contains ``` fence', {});
	assert.ok(md.includes('````'), 'uses a longer fence');
});

// ── terminal-command attachment parsing ───────────────────────────────────

test('context: parseTerminalAttachment parses command, output, exit code', () => {
	const value = 'Command: npm test\nOutput:\nPASS 1\nPASS 2\nExit Code: 0';
	const parsed = parseTerminalAttachment(value);
	assert.strictEqual(parsed.command, 'npm test');
	assert.strictEqual(parsed.output, 'PASS 1\nPASS 2');
	assert.strictEqual(parsed.exitCode, 0);
});

test('context: parseTerminalAttachment handles missing output / nonzero exit', () => {
	const parsed = parseTerminalAttachment('Command: ls\nExit Code: 2');
	assert.strictEqual(parsed.command, 'ls');
	assert.strictEqual(parsed.output, '');
	assert.strictEqual(parsed.exitCode, 2);
});

test('context: parseTerminalAttachment rejects non-terminal strings', () => {
	assert.strictEqual(parseTerminalAttachment('just some text'), null);
	assert.strictEqual(parseTerminalAttachment('Command: do a thing then explain'), null);
});

// ── terminal selection → chat attachment ──────────────────────────────────

test('terminalContext: formatTerminalSelection fences output and labels by name', () => {
	const snippet = formatTerminalSelection('npm test\nFAIL', 'zsh');
	assert.strictEqual(snippet.name, 'Terminal: zsh');
	assert.ok(snippet.text.includes('npm test\nFAIL'), 'includes the selected text');
	assert.ok(/```[\s\S]*npm test/.test(snippet.text), 'wraps the selection in a fence');
});

test('terminalContext: formatTerminalSelection widens fence past backticks', () => {
	const snippet = formatTerminalSelection('echo ```hi```', undefined);
	assert.strictEqual(snippet.name, 'Terminal selection');
	assert.ok(snippet.text.includes('````'), 'uses a longer fence than the content');
});

test('terminalContext: formatTerminalSelection returns null for empty selection', () => {
	assert.strictEqual(formatTerminalSelection('', 'zsh'), null);
	assert.strictEqual(formatTerminalSelection('   \n\t ', 'zsh'), null);
	assert.strictEqual(formatTerminalSelection(undefined, 'zsh'), null);
});

// ── command gating (bash approval) ────────────────────────────────────────

const BASH_PERMISSION_EVENT = {
	type: 'permission.asked',
	properties: {
		id: 'perm_1',
		sessionID: 'ses_test',
		permission: 'bash',
		patterns: ['rm -rf build'],
		metadata: { command: 'rm -rf build' }
	}
};

function makeCommandDriver(approveCommand) {
	const events = [];
	const driver = new OpencodeDriver((e) => events.push(e), { approveCommand });
	driver.sessionId = 'ses_test';
	return { driver, events };
}

test('driver: ruleset gates bash only when commandApproval is ask', () => {
	const d = new OpencodeDriver(() => { });
	assert.deepStrictEqual(d.buildSessionRuleset(), [{ permission: 'edit', pattern: '*', action: 'ask' }]);
	d.configure({ commandApproval: 'ask' });
	const gated = d.buildSessionRuleset();
	assert.strictEqual(gated.length, 2);
	assert.ok(gated.some((r) => r.permission === 'bash' && r.action === 'ask'));
	d.configure({ commandApproval: 'auto' });
	assert.strictEqual(d.buildSessionRuleset().length, 1);
});

testAsync('permission.asked bash: allow replies once', async () => {
	apiCalls.length = 0;
	const { driver } = makeCommandDriver(async () => 'once');
	driver.handleServerEvent(BASH_PERMISSION_EVENT, 'http://mock', () => { });
	await settle();
	const post = apiCalls.find((c) => c.path === '/session/ses_test/permissions/perm_1');
	assert.ok(post, 'permission reply not posted');
	assert.strictEqual(post.opts.body.response, 'once');
});

testAsync('permission.asked bash: allow-for-session replies always', async () => {
	apiCalls.length = 0;
	const { driver } = makeCommandDriver(async () => 'always');
	driver.handleServerEvent(BASH_PERMISSION_EVENT, 'http://mock', () => { });
	await settle();
	const post = apiCalls.find((c) => c.path === '/session/ses_test/permissions/perm_1');
	assert.strictEqual(post.opts.body.response, 'always');
});

testAsync('permission.asked bash: deny replies reject', async () => {
	apiCalls.length = 0;
	const { driver } = makeCommandDriver(async () => 'reject');
	driver.handleServerEvent(BASH_PERMISSION_EVENT, 'http://mock', () => { });
	await settle();
	const post = apiCalls.find((c) => c.path === '/session/ses_test/permissions/perm_1');
	assert.strictEqual(post.opts.body.response, 'reject');
});

testAsync('permission.asked bash: no callback auto-approves (always)', async () => {
	apiCalls.length = 0;
	const { driver } = makeCommandDriver(undefined);
	driver.handleServerEvent(BASH_PERMISSION_EVENT, 'http://mock', () => { });
	await settle();
	const post = apiCalls.find((c) => c.path === '/session/ses_test/permissions/perm_1');
	assert.strictEqual(post.opts.body.response, 'always');
});

testAsync('permission.asked bash: command text is handed to the UI', async () => {
	apiCalls.length = 0;
	let seen = null;
	const { driver } = makeCommandDriver(async (req) => { seen = req; return 'once'; });
	driver.handleServerEvent(BASH_PERMISSION_EVENT, 'http://mock', () => { });
	await settle();
	assert.ok(seen, 'approveCommand was not called');
	assert.strictEqual(seen.command, 'rm -rf build');
	assert.deepStrictEqual(seen.patterns, ['rm -rf build']);
});

testAsync('permission.asked bash: callback throw falls back to always (turn never hangs)', async () => {
	apiCalls.length = 0;
	const { driver } = makeCommandDriver(async () => { throw new Error('ui broke'); });
	driver.handleServerEvent(BASH_PERMISSION_EVENT, 'http://mock', () => { });
	await settle();
	const post = apiCalls.find((c) => c.path === '/session/ses_test/permissions/perm_1');
	assert.strictEqual(post.opts.body.response, 'always');
});

testAsync('interrupt rejects a pending bash permission and skips the late reply', async () => {
	apiCalls.length = 0;
	let resolveDecision;
	// The approval UI is still open (promise pending) when the user interrupts.
	const { driver } = makeCommandDriver(() => new Promise((resolve) => { resolveDecision = resolve; }));
	driver.handleServerEvent(BASH_PERMISSION_EVENT, 'http://mock', () => { });
	await settle();
	assert.strictEqual(apiCalls.length, 0); // still waiting on the user

	driver.interrupt();
	await settle();
	const reject = apiCalls.find((c) => c.path === '/session/ses_test/permissions/perm_1');
	assert.ok(reject, 'pending permission was not rejected on interrupt');
	assert.strictEqual(reject.opts.body.response, 'reject');
	assert.ok(apiCalls.some((c) => c.path === '/session/ses_test/abort'), 'session not aborted');

	// The user's late choice must not produce a second (stale) reply.
	apiCalls.length = 0;
	resolveDecision('once');
	await settle();
	assert.ok(!apiCalls.some((c) => c.path === '/session/ses_test/permissions/perm_1'), 'stale reply was sent');
});

(async () => {
	for (const { name, fn } of asyncTests) {
		try {
			await fn();
			console.log(`  ok   ${name}`);
		} catch (err) {
			failures++;
			console.error(`  FAIL ${name}: ${err.message}`);
		}
	}
	console.log(failures === 0 ? '\nAll unit tests passed.' : `\n${failures} test(s) FAILED.`);
	process.exit(failures === 0 ? 0 : 1);
})();
