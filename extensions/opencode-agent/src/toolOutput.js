'use strict';
// Render a shell command's output for the chat (Cursor-style "see the log").
//
// When opencode runs its `bash` tool we already show a progress row with the
// command, but the actual stdout/stderr was dropped — you had to dig through
// opencode's own output channel to see what a command printed. This formats the
// captured output into a fenced block: tail-capped (the end of a run is usually
// the interesting part), fence-safe (won't be broken by backticks in the
// output), and labeled with success/failure.

const MAX_LINES = 40;
const MAX_CHARS = 4000;

/** A code fence longer than any backtick run inside `text`, so it can't break. */
function fenceFor(text) {
	let max = 0;
	let run = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '`') {
			run++;
			if (run > max) {
				max = run;
			}
		} else {
			run = 0;
		}
	}
	return '`'.repeat(Math.max(3, max + 1));
}

/**
 * Format shell output as a markdown block, or '' when there's nothing useful to
 * show (empty output from a successful command).
 *
 * @param {string} content stdout/stderr captured from the tool result
 * @param {{ isError?: boolean, maxLines?: number, maxChars?: number }} [opts]
 * @returns {string}
 */
function formatShellOutput(content, opts = {}) {
	const isError = !!opts.isError;
	const maxLines = typeof opts.maxLines === 'number' ? opts.maxLines : MAX_LINES;
	const maxChars = typeof opts.maxChars === 'number' ? opts.maxChars : MAX_CHARS;

	let text = typeof content === 'string' ? content.replace(/\s+$/, '') : '';
	if (!text.trim()) {
		// A failed command with no output still deserves a note.
		return isError ? '\n\n_Command failed (no output)._\n\n' : '';
	}

	let lines = text.split('\n');
	let hiddenLines = 0;
	if (lines.length > maxLines) {
		hiddenLines = lines.length - maxLines;
		lines = lines.slice(-maxLines); // keep the tail
	}
	let body = lines.join('\n');
	if (body.length > maxChars) {
		body = body.slice(body.length - maxChars);
	}

	const note = hiddenLines > 0 ? ` _(last ${maxLines} of ${hiddenLines + maxLines} lines)_` : '';
	const label = isError ? 'Output (failed)' : 'Output';
	const fence = fenceFor(body);
	return `\n\n**${label}**${note}\n\n${fence}\n${body}\n${fence}\n\n`;
}

module.exports = { formatShellOutput, fenceFor };
