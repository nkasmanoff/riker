'use strict';
// Standalone smoke test for the server-based driver (no VS Code host).
// Exercises the exact code paths the chat participant uses and prints the
// normalized events, so we can confirm end-to-end behavior deterministically.
//
// Verifies the properties the chat UI depends on:
//   - text arrives as MANY deltas (true streaming), not one blob
//   - reasoning arrives as thinking-delta events
//   - tool events fire with fileEdit metadata (incl. a diff for edits)
//   - session id is reused across turns
//   - the approveEdit callback gates every edit (and 'reject' blocks the write)

const path = require('path');
const os = require('os');
const fs = require('fs');
const { OpencodeDriver } = require('../src/opencode');
const { getOpencodeDescriptor } = require('../src/descriptor');
const { disposeServer } = require('../src/server');

async function main() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-smoke-'));
	fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello world\nsecond line\n');

	const desc = await getOpencodeDescriptor();
	console.log('[descriptor] models:', desc.models.length, 'default:', desc.defaultModel);

	const events = [];
	const approvals = [];
	let denyNextEdit = false;
	const approveEdit = (req) => {
		approvals.push(req);
		const reply = denyNextEdit ? 'reject' : 'once';
		console.log(`\n[approveEdit] ${req.filepath} diff=${!!req.diff} -> ${reply}`);
		return Promise.resolve(reply);
	};
	const driver = new OpencodeDriver((e) => {
		events.push(e);
		if (e.kind === 'text-delta') {
			process.stdout.write(`\x1b[36m${e.text}\x1b[0m`);
		} else if (e.kind === 'thinking-delta') {
			process.stdout.write(`\x1b[90m${e.text}\x1b[0m`);
		} else if (e.kind === 'tool-start') {
			console.log(`\n[tool-start] ${e.name} ${JSON.stringify(e.input).slice(0, 80)}`);
		} else if (e.kind === 'tool-result') {
			const extra = e.fileEdit
				? ` fileEdit(diff=${!!(e.fileEdit.patch || e.fileEdit.diff)} gateDiff=${!!e.fileEdit.gateDiff})`
				: e.fileRead ? ' fileRead' : '';
			console.log(`[tool-result] ${e.name} isError=${e.isError}${extra}`);
		} else if (e.kind === 'session') {
			console.log(`[session] ${e.sessionId}`);
		} else if (e.kind === 'error') {
			console.log(`[error] ${e.message}`);
		} else if (e.kind === 'turn-complete') {
			console.log(`\n[turn-complete] cost=$${(e.costUsd || 0).toFixed(4)}`);
		} else if (e.kind === 'status') {
			console.log(`[status] ${e.status}`);
		}
	}, { approveEdit });

	driver.configure({ projectDir: dir, model: desc.defaultModel, mode: 'build' });

	console.log('\n=== Turn 1: edit a file ===');
	await driver.send('Use the edit tool to change "second" to "SECOND" in hello.txt. Reply briefly.');

	console.log('\n=== Turn 2: session continuity ===');
	console.log('[resume sessionId]', driver.sessionId);
	await driver.send('What was the filename I just asked you about? Answer, then write a 8-line poem about that file.');

	console.log('\n=== Turn 3: blind overwrite (pre-apply gate) ===');
	fs.writeFileSync(path.join(dir, 'blind.txt'), 'original alpha\noriginal beta\n');
	await driver.send('Create blind.txt containing exactly two lines: "replaced one" and "replaced two". Use a single write tool call (overwrite if it exists), nothing else. Reply briefly.');

	console.log('\n=== Turn 4: denied edit (gate blocks the write) ===');
	denyNextEdit = true;
	const beforeDeny = fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8');
	await driver.send('Use the edit tool to change "SECOND" back to "second" in hello.txt. Reply briefly.');
	const afterDeny = fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8');
	const denyOk = afterDeny === beforeDeny;

	const textDeltas = events.filter((e) => e.kind === 'text-delta').length;
	const thinkingDeltas = events.filter((e) => e.kind === 'thinking-delta').length;
	const edits = events.filter((e) => e.kind === 'tool-result' && e.fileEdit);
	const kinds = new Set(events.map((e) => e.kind));

	// The blind write must carry a gate diff whose removed lines are the
	// original content — proof the permission gate captured "before" pre-write.
	const blindWrite = edits.find((e) => e.fileEdit.tool === 'write' && /blind\.txt$/.test(e.fileEdit.filePath || ''));
	const gateOk = !!(blindWrite && blindWrite.fileEdit.gateDiff && blindWrite.fileEdit.gateDiff.includes('-original alpha'));

	console.log('\n=== event kinds seen:', [...kinds].join(', '));
	console.log(`=== text deltas: ${textDeltas} (streaming requires > 3)`);
	console.log(`=== thinking deltas: ${thinkingDeltas}`);
	console.log(`=== file edits with diff: ${edits.filter((e) => e.fileEdit.patch || e.fileEdit.diff || e.fileEdit.gateDiff).length}/${edits.length}`);
	console.log(`=== blind overwrite gate diff captured: ${gateOk}`);
	console.log(`=== approvals requested: ${approvals.length} (with diff: ${approvals.filter((a) => a.diff).length})`);
	console.log(`=== denied edit left file untouched: ${denyOk}`);
	console.log('=== final file content:', JSON.stringify(fs.readFileSync(path.join(dir, 'hello.txt'), 'utf8')));
	console.log('=== blind file content:', JSON.stringify(fs.readFileSync(path.join(dir, 'blind.txt'), 'utf8')));

	const pass = textDeltas > 3 && kinds.has('session') && kinds.has('tool-result') && gateOk
		&& approvals.length >= 3 && denyOk;
	console.log(pass ? '=== SMOKE PASS' : '=== SMOKE FAIL');

	driver.dispose();
	disposeServer();
	process.exit(pass ? 0 : 1);
}

main().catch((e) => {
	console.error('SMOKE FAILED:', e);
	disposeServer();
	process.exit(1);
});
