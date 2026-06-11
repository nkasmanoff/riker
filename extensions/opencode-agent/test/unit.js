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
const { splitModelId } = require('../src/opencode');

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

console.log(failures === 0 ? '\nAll unit tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
