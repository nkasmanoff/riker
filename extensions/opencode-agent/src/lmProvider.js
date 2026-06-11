'use strict';
// Language model chat provider for opencode.
//
// VS Code's chat framework resolves `request.model` (a registered language
// model) BEFORE invoking a chat participant. With Copilot disabled there are no
// models, so participant invocation fails with "Language model unavailable".
//
// We register opencode's discovered models so:
//   1. `request.model` resolves and our participant runs.
//   2. The models show up in the native model picker (Phase 2).
//
// The opencode CLI runs its own agentic loop, so the real turn is driven by the
// chat *participant* (see extension.js). This provider's response method is a
// thin shim: it streams a single opencode turn for the given prompt. It is only
// exercised if something calls the language model API directly.

const vscode = require('vscode');
const { OpencodeDriver } = require('./opencode');
const { getOpencodeDescriptor } = require('./descriptor');

const VENDOR = 'opencode';

/**
 * @param {import('vscode').ExtensionContext} ctx
 * @param {vscode.OutputChannel} output
 */
async function registerLanguageModelProvider(ctx, output) {
	const desc = await getOpencodeDescriptor();

	// The chat framework only resolves a provider's models into the main-thread
	// cache (which feeds the model picker) when the provider fires its change
	// event. Without this, registration alone leaves the picker showing only
	// "Auto". We fire it once after registration to trigger initial resolution.
	const onDidChangeEmitter = new vscode.EventEmitter();

	/** @type {vscode.LanguageModelChatProvider} */
	const provider = {
		onDidChangeLanguageModelChatInformation: onDidChangeEmitter.event,
		async provideLanguageModelChatInformation(_options, _token) {
			const desc2 = await getOpencodeDescriptor();
			return desc2.models.map((m) => ({
				id: m.id,
				name: m.label,
				family: m.hint || 'opencode',
				version: '1.0.0',
				maxInputTokens: 200000,
				maxOutputTokens: 16000,
				detail: m.hint,
				isDefault: m.id === desc2.defaultModel,
				isUserSelectable: true,
				capabilities: {
					// opencode runs its own agentic loop with real tools (Edit,
					// Write, Bash, …). We must advertise toolCalling so the model
					// passes `suitableForAgentMode` and appears in the picker when
					// the chat is in Agent mode (the default). Without this every
					// opencode model is filtered out and the picker shows only
					// "Auto". The actual tool execution still happens inside the
					// opencode CLI, driven by our chat participant — VS Code's
					// agent loop does not drive tool calls through this provider.
					toolCalling: true
				}
			}));
		},

		async provideLanguageModelChatResponse(model, messages, _options, progress, token) {
			// Thin shim: stream a single opencode turn for the latest user text.
			const prompt = lastUserText(messages);
			const projectDir =
				vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

			await new Promise((resolve) => {
				const driver = new OpencodeDriver((event) => {
					if (event.kind === 'text-delta') {
						progress.report(new vscode.LanguageModelTextPart(event.text));
					} else if (event.kind === 'error') {
						progress.report(new vscode.LanguageModelTextPart(`\n[opencode error] ${event.message}\n`));
					} else if (event.kind === 'turn-complete') {
						resolve();
					}
				});
				driver.configure({ projectDir, model: model.id, mode: 'build' });
				token.onCancellationRequested(() => {
					driver.interrupt();
					resolve();
				});
				driver.send(prompt).then(() => resolve());
			});
		},

		async provideTokenCount(_model, text, _token) {
			// Rough heuristic: ~4 chars/token. opencode tracks real usage itself.
			const str = typeof text === 'string' ? text : JSON.stringify(text);
			return Math.ceil(str.length / 4);
		}
	};

	const disposable = vscode.lm.registerLanguageModelChatProvider(VENDOR, provider);
	ctx.subscriptions.push(onDidChangeEmitter, disposable);
	output.appendLine(`Registered language model provider '${VENDOR}' with ${desc.models.length} models.`);

	// Kick off initial model resolution so the picker populates immediately
	// rather than after the first chat turn.
	onDidChangeEmitter.fire();
}

/** Extract the most recent user message text from the LM message array. */
function lastUserText(messages) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		const parts = msg && msg.content ? msg.content : [];
		const text = parts
			.map((p) => (p && typeof p.value === 'string' ? p.value : ''))
			.join('');
		if (text.trim()) {
			return text;
		}
	}
	return '';
}

module.exports = { registerLanguageModelProvider, VENDOR };
