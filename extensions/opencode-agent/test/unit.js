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

testAsync('send: assistant tokens surface on turn-complete', async () => {
	apiCalls.length = 0;
	const { driver, events } = makeDriver(undefined);
	const turn = driver.send('hello');
	await settle();
	const tokens = { input: 1000, output: 200, reasoning: 50, cache: { read: 5000, write: 100 } };
	lastEventSink({
		type: 'message.updated',
		properties: { info: { sessionID: 'ses_test', role: 'assistant', id: 'msg_a', tokens } }
	});
	lastEventSink({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
	await turn;
	const complete = events.find((e) => e.kind === 'turn-complete');
	assert.ok(complete, 'turn-complete not emitted');
	assert.deepStrictEqual(complete.tokens, tokens);
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
