'use strict';
// "Add terminal selection to chat" — the Cursor interaction where you select
// text in the integrated terminal (a stack trace, a failing command's output)
// and drop it into the agent so you can ask about it.
//
// VS Code core never wired terminal text into chat as context (it was a Copilot
// extension feature), so we add it: read the active terminal's selection via the
// `terminalSelection` proposed API, then open the opencode panel with the text
// attached as a `generic` context chip (see the `attachText` option on
// `workbench.action.chat.open`, added in our chatActions.ts patch). The chip
// flows to the participant as a string `request.reference`, which context.js
// inlines for opencode.

const { fenceFor } = require('./toolOutput');

let vscode = null;
try { vscode = require('vscode'); } catch { /* tests */ }

/**
 * Shape a raw terminal selection into an attachable snippet: a fenced block
 * (fence widened so backticks in the output can't break it) plus a short label.
 *
 * @param {string} selection the raw selected text
 * @param {string} [terminalName] the terminal's name, used in the chip label
 * @returns {{ name: string, text: string } | null} null when there's nothing to attach
 */
function formatTerminalSelection(selection, terminalName) {
	const trimmed = typeof selection === 'string' ? selection.replace(/\s+$/, '') : '';
	if (!trimmed.trim()) {
		return null;
	}
	const name = terminalName ? `Terminal: ${terminalName}` : 'Terminal selection';
	const fence = fenceFor(trimmed);
	const text = `Terminal selection:\n\n${fence}\n${trimmed}\n${fence}`;
	return { name, text };
}

/** Register the `opencode.addTerminalSelectionToChat` command. */
function registerTerminalContext(ctx, output) {
	ctx.subscriptions.push(vscode.commands.registerCommand('opencode.addTerminalSelectionToChat', async () => {
		const terminal = vscode.window.activeTerminal;
		let selection;
		// `selection` is behind the `terminalSelection` proposed API; guard in
		// case it isn't available so the command degrades instead of throwing.
		try { selection = terminal && terminal.selection; } catch { selection = undefined; }

		const snippet = formatTerminalSelection(selection, terminal && terminal.name);
		if (!snippet) {
			vscode.window.showInformationMessage(
				'opencode: Select some text in the terminal first, then run "Add Terminal Selection to opencode Chat".'
			);
			return;
		}

		try {
			await vscode.commands.executeCommand('workbench.action.chat.open', {
				attachText: [{ name: snippet.name, text: snippet.text }]
			});
		} catch (err) {
			if (output) {
				output.appendLine(`addTerminalSelectionToChat failed: ${err && err.message}`);
			}
		}
	}));
}

module.exports = {
	registerTerminalContext,
	// Exported for unit tests.
	formatTerminalSelection
};
