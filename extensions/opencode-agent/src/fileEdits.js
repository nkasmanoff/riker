'use strict';
// Helpers for surfacing opencode's eager file edits in the chat editing UI.
//
// opencode writes files to disk before the tool-completed event arrives, but
// the driver's pre-apply permission gate (see opencode.js) captures the exact
// old→new diff *before* each write, so a "before" is recoverable even for
// blind overwrites.
//
// We reconstruct the *original* (pre-edit) content from that data, then drive
// VS Code's `externalEdit` API in a restore-then-replay fashion:
//
//   1. write the reconstructed "before" content back to disk
//   2. open an externalEdit window (VS Code snapshots the restored original)
//   3. inside the callback, write the real "after" content back
//   4. VS Code diffs before -> after and renders accept/reject pills
//
// Net on-disk state is unchanged; the user just gains the diff + accept/reject.
//
// SAFETY: every reconstruction is validated. If we cannot prove the "before"
// content is correct, we return null and the caller falls back to a plain
// reference (no pill, but never a corrupted file).

// Appended by opencode's read tool to lines longer than 2000 chars. Such a
// read is lossy and must not be used as a snapshot.
const READ_LINE_TRUNCATION_SUFFIX = '... (line truncated to 2000 chars)';

/**
 * Extract the full file content from opencode's `read` tool output, which
 * looks like:
 *
 *   <path>/abs/path</path>
 *   <type>file</type>
 *   <content>
 *   1: first line
 *   2: second line
 *
 *   (End of file - total 2 lines)
 *   </content>
 *
 * Returns the reconstructed content, or null when the output is not a
 * complete, lossless read (directory listing, offset/limit window, byte cap,
 * truncated long lines, unexpected shape).
 *
 * NOTE: the line-based format cannot represent whether the file ended with a
 * trailing newline; we assume it did (true for virtually all source files).
 * Callers use this only as a best-effort "before" for diff display, so the
 * worst case of a wrong guess is a slightly-off diff, never data loss beyond
 * what the overwrite itself already did.
 *
 * @param {string} output raw `read` tool output
 * @returns {string | null}
 */
function parseReadToolOutput(output) {
	if (typeof output !== 'string') {
		return null;
	}
	const header = output.indexOf('<type>file</type>\n<content>\n');
	if (header === -1 || !output.startsWith('<path>')) {
		return null;
	}
	const start = header + '<type>file</type>\n<content>\n'.length;
	const end = output.indexOf('\n</content>', start);
	if (end === -1) {
		return null;
	}
	const body = output.slice(start, end);

	// A complete read ends with "(End of file - total N lines)". Partial reads
	// say "Showing lines …" or "Output capped …" instead — reject those.
	const tail = /\n\n\(End of file - total (\d+) lines\)$/.exec(body);
	if (!tail) {
		return null;
	}
	const totalLines = parseInt(tail[1], 10);
	const linesBlock = body.slice(0, tail.index);

	if (totalLines === 0) {
		return linesBlock === '' ? '' : null;
	}

	const rawLines = linesBlock.split('\n');
	if (rawLines.length !== totalLines) {
		return null; // offset/limit window or unexpected shape
	}

	const lines = [];
	for (let i = 0; i < rawLines.length; i++) {
		const m = /^(\d+): (.*)$/s.exec(rawLines[i]);
		if (!m || parseInt(m[1], 10) !== i + 1) {
			return null; // not a 1-based complete read
		}
		if (m[2].endsWith(READ_LINE_TRUNCATION_SUFFIX)) {
			return null; // long line was cut; snapshot would be lossy
		}
		lines.push(m[2]);
	}

	// Assume a trailing newline (see NOTE above).
	return lines.join('\n') + '\n';
}

/**
 * Reverse-apply a unified diff to `afterText` to recover the pre-edit text.
 * Returns the reconstructed "before" string, or null if the diff does not
 * cleanly match `afterText` (in which case the caller must not replay).
 *
 * @param {string} afterText current on-disk content (post-edit)
 * @param {string} diff unified diff as produced by opencode (`metadata.diff`)
 * @returns {string | null}
 */
function reconstructBeforeFromDiff(afterText, diff) {
	if (typeof afterText !== 'string' || typeof diff !== 'string' || !diff) {
		return null;
	}

	const trailingNewline = afterText.endsWith('\n');
	// Work on lines without the trailing empty element from a final newline.
	const afterLines = afterText.split('\n');
	if (trailingNewline) {
		afterLines.pop();
	}

	const diffLines = diff.split('\n');
	const beforeLines = [];
	let ai = 0; // index into afterLines

	let i = 0;
	// Skip preamble until the first hunk header.
	while (i < diffLines.length && !diffLines[i].startsWith('@@')) {
		i++;
	}
	if (i >= diffLines.length) {
		return null; // no hunks found
	}

	for (; i < diffLines.length; i++) {
		const line = diffLines[i];

		if (line.startsWith('@@')) {
			// Hunk header: @@ -oldStart,oldCount +newStart,newCount @@
			const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
			if (!match) {
				return null;
			}
			const newStart = parseInt(match[3], 10) - 1; // 0-based
			// Copy untouched lines preceding this hunk verbatim.
			while (ai < newStart) {
				if (ai >= afterLines.length) {
					return null;
				}
				beforeLines.push(afterLines[ai]);
				ai++;
			}
			continue;
		}

		// File header lines inside a diff body — ignore.
		if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('Index:') || line.startsWith('===')) {
			continue;
		}

		// "\ No newline at end of file" marker — informational.
		if (line.startsWith('\\')) {
			continue;
		}

		const tag = line[0];
		const text = line.slice(1);

		if (tag === ' ') {
			// Context: present in both; must match after content.
			if (afterLines[ai] !== text) {
				return null;
			}
			beforeLines.push(text);
			ai++;
		} else if (tag === '+') {
			// Added in after: must match after content; absent from before.
			if (afterLines[ai] !== text) {
				return null;
			}
			ai++;
		} else if (tag === '-') {
			// Removed from after: present only in before.
			beforeLines.push(text);
		} else if (line === '') {
			// Blank line in the diff stream (often a trailing newline). Treat as
			// a context blank only if it matches; otherwise ignore at the very end.
			if (ai < afterLines.length && afterLines[ai] === '') {
				beforeLines.push('');
				ai++;
			}
		} else {
			return null; // unexpected line shape
		}
	}

	// Copy any remaining untouched tail.
	while (ai < afterLines.length) {
		beforeLines.push(afterLines[ai]);
		ai++;
	}

	let before = beforeLines.join('\n');
	if (trailingNewline) {
		before += '\n';
	}
	return before;
}

/**
 * Reconstruct the pre-edit ("before") content for a single file edit.
 *
 * @param {object} fileEdit normalized edit info from the driver
 * @param {string} afterText current on-disk content
 * @returns {{ before: string } | null} null if reconstruction is unsafe
 */
function reconstructBefore(fileEdit, afterText) {
	if (!fileEdit) {
		return null;
	}

	// `write` to a brand-new file: before content is empty (file did not exist).
	if (fileEdit.tool === 'write') {
		if (fileEdit.existedBefore === false) {
			return { before: '' };
		}
		// Overwrite of an existing file. Best source: the pre-apply gate diff
		// captured from permission.asked before the write happened. Reverse-
		// applying it validates every context/+ line against afterText.
		if (fileEdit.gateDiff) {
			const before = reconstructBeforeFromDiff(afterText, fileEdit.gateDiff);
			if (before !== null) {
				return { before };
			}
		}
		// Fallback: snapshot-on-read from earlier in the turn. Validate that the
		// post-state matches what the write claims to have written.
		if (
			typeof fileEdit.snapshotBefore === 'string' &&
			typeof fileEdit.newText === 'string' &&
			afterText === fileEdit.newText
		) {
			return { before: fileEdit.snapshotBefore };
		}
		// No gate diff and no snapshot: cannot recover the original safely.
		return null;
	}

	// edit / patch: prefer the unified diff (post-tool metadata, then the
	// pre-apply gate diff).
	for (const diff of [fileEdit.diff, fileEdit.gateDiff]) {
		if (diff) {
			const before = reconstructBeforeFromDiff(afterText, diff);
			if (before !== null) {
				return { before };
			}
		}
	}

	// Fallback for edit: swap newString -> oldString (first occurrence).
	if (
		fileEdit.tool === 'edit' &&
		typeof fileEdit.oldString === 'string' &&
		typeof fileEdit.newString === 'string' &&
		fileEdit.newString.length > 0 &&
		afterText.includes(fileEdit.newString)
	) {
		const idx = afterText.indexOf(fileEdit.newString);
		const before =
			afterText.slice(0, idx) +
			fileEdit.oldString +
			afterText.slice(idx + fileEdit.newString.length);
		return { before };
	}

	return null;
}

/**
 * Compute a unified diff (hunks only, no file header) between two strings.
 * LCS-based with common prefix/suffix trimming; used for the inline ```diff
 * rendering of `write` overwrites where opencode provides no diff but we hold
 * a snapshot. Returns '' when the texts are equal.
 *
 * @param {string} before
 * @param {string} after
 * @param {number} context context lines around changes (default 3)
 * @returns {string}
 */
function computeUnifiedDiff(before, after, context = 3) {
	if (before === after) {
		return '';
	}
	// Unified-diff convention: a trailing newline terminates the last line, it
	// does not start an empty one.
	const a = before.split('\n');
	if (before.endsWith('\n')) {
		a.pop();
	}
	const b = after.split('\n');
	if (after.endsWith('\n')) {
		b.pop();
	}

	// Trim common prefix/suffix so the DP only sees the changed middle.
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) {
		start++;
	}
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
		endA--;
		endB--;
	}

	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);

	/** @type {{ t: ' ' | '-' | '+', l: string }[]} */
	let mid;
	if (midA.length * midB.length > 4_000_000) {
		// Too large for the DP table; degrade to a full replace of the middle.
		mid = [...midA.map((l) => ({ t: '-', l })), ...midB.map((l) => ({ t: '+', l }))];
	} else {
		const n = midA.length;
		const m = midB.length;
		const w = m + 1;
		const dp = new Uint32Array((n + 1) * w);
		for (let i = n - 1; i >= 0; i--) {
			for (let j = m - 1; j >= 0; j--) {
				dp[i * w + j] = midA[i] === midB[j]
					? dp[(i + 1) * w + j + 1] + 1
					: Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
			}
		}
		mid = [];
		let i = 0;
		let j = 0;
		while (i < n && j < m) {
			if (midA[i] === midB[j]) {
				mid.push({ t: ' ', l: midA[i] });
				i++; j++;
			} else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
				mid.push({ t: '-', l: midA[i] });
				i++;
			} else {
				mid.push({ t: '+', l: midB[j] });
				j++;
			}
		}
		while (i < n) { mid.push({ t: '-', l: midA[i++] }); }
		while (j < m) { mid.push({ t: '+', l: midB[j++] }); }
	}

	const ops = [
		...a.slice(0, start).map((l) => ({ t: ' ', l })),
		...mid,
		...a.slice(endA).map((l) => ({ t: ' ', l }))
	];

	// Group into hunks with `context` lines around changes.
	const changedIdx = [];
	for (let k = 0; k < ops.length; k++) {
		if (ops[k].t !== ' ') {
			changedIdx.push(k);
		}
	}
	if (changedIdx.length === 0) {
		return '';
	}

	const hunks = [];
	let hunkStart = Math.max(0, changedIdx[0] - context);
	let hunkEnd = Math.min(ops.length, changedIdx[0] + context + 1);
	for (let c = 1; c < changedIdx.length; c++) {
		const k = changedIdx[c];
		if (k - context <= hunkEnd) {
			hunkEnd = Math.min(ops.length, k + context + 1);
		} else {
			hunks.push([hunkStart, hunkEnd]);
			hunkStart = Math.max(0, k - context);
			hunkEnd = Math.min(ops.length, k + context + 1);
		}
	}
	hunks.push([hunkStart, hunkEnd]);

	// Render hunks, tracking 1-based old/new line numbers.
	const out = [];
	let oldLn = 1;
	let newLn = 1;
	let cursor = 0;
	for (const [hs, he] of hunks) {
		// Advance line counters over the unchanged gap before this hunk.
		for (; cursor < hs; cursor++) {
			const t = ops[cursor].t;
			if (t === ' ') { oldLn++; newLn++; }
			else if (t === '-') { oldLn++; }
			else { newLn++; }
		}
		const oldStart = oldLn;
		const newStart = newLn;
		const body = [];
		let oldCount = 0;
		let newCount = 0;
		for (; cursor < he; cursor++) {
			const { t, l } = ops[cursor];
			body.push(t + l);
			if (t === ' ') { oldLn++; newLn++; oldCount++; newCount++; }
			else if (t === '-') { oldLn++; oldCount++; }
			else { newLn++; newCount++; }
		}
		out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
		out.push(...body);
	}
	return out.join('\n');
}

const MAX_DISPLAY_DIFF_LINES = 300;

/**
 * Build the unified-diff text to render inline in chat for a single file
 * edit, preferring the diffs opencode provides. Returns null when no diff
 * can be shown (true blind overwrite).
 *
 * @param {object} fileEdit normalized edit info from the driver
 * @returns {string | null}
 */
function displayDiff(fileEdit) {
	let diff = null;

	const provided = fileEdit.patch ?? fileEdit.diff ?? fileEdit.gateDiff;
	if (typeof provided === 'string' && provided.trim()) {
		diff = provided;
	} else if (fileEdit.tool === 'write' && typeof fileEdit.newText === 'string') {
		if (fileEdit.existedBefore === false) {
			// New file: render as all-added.
			const lines = fileEdit.newText.replace(/\n$/, '').split('\n');
			diff = lines.map((l) => '+' + l).join('\n');
		} else if (typeof fileEdit.snapshotBefore === 'string') {
			diff = computeUnifiedDiff(fileEdit.snapshotBefore, fileEdit.newText);
		}
	}

	if (!diff || !diff.trim()) {
		return null;
	}

	// Strip file headers; keep hunk markers and +/-/context lines.
	const lines = diff.split('\n').filter((l) =>
		!l.startsWith('Index:') &&
		!l.startsWith('===') &&
		!l.startsWith('--- ') &&
		!l.startsWith('+++ ') &&
		!l.startsWith('\\')
	);
	while (lines.length && lines[lines.length - 1] === '') {
		lines.pop();
	}
	if (lines.length === 0) {
		return null;
	}
	if (lines.length > MAX_DISPLAY_DIFF_LINES) {
		const omitted = lines.length - MAX_DISPLAY_DIFF_LINES;
		lines.length = MAX_DISPLAY_DIFF_LINES;
		lines.push(`@@ … ${omitted} more lines not shown @@`);
	}
	return lines.join('\n');
}

module.exports = { reconstructBeforeFromDiff, reconstructBefore, parseReadToolOutput, computeUnifiedDiff, displayDiff };
