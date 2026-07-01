'use strict';
// Turns VS Code chat attachments (`request.references`) into context opencode
// can actually use.
//
// Without this, the handler only forwarded `request.prompt`, so anything the
// user explicitly attached — an `@file`, a folder, a code selection, a pasted
// screenshot — was silently dropped and opencode had to re-discover it by
// searching. This is the most-used Cursor interaction, so we forward it:
//
//   - File (Uri)            -> inlined as a fenced code block (path + content)
//   - Selection (Location)  -> inlined as a fenced block (path + line range)
//   - Folder (Uri dir)      -> a shallow listing of its entries
//   - Image (binary data)   -> a `data:` URL `file` part (opencode passes media
//                              parts straight to the model)
//   - String                -> inlined verbatim as a labeled block
//
// Text is inlined directly (rather than relying on opencode resolving `file://`
// parts) so behavior is identical across opencode versions and the model sees
// the content immediately. Size is capped per-file and overall so a stray
// "attach this whole folder" can't blow the context window.

const path = require('path');

// Guarded so the pure helpers stay importable by test/unit.js, which runs in
// plain Node without a VS Code host. Production callers pass their own `fs`.
let vscode = null;
try { vscode = require('vscode'); } catch { /* tests */ }

const PER_FILE_MAX_CHARS = 64000;
const TOTAL_MAX_CHARS = 256000;
const MAX_DIR_ENTRIES = 100;

const LANG_BY_EXT = {
	js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
	ts: 'typescript', tsx: 'typescript', json: 'json', jsonc: 'json',
	md: 'markdown', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
	java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
	cs: 'csharp', php: 'php', sh: 'bash', zsh: 'bash', bash: 'bash',
	yml: 'yaml', yaml: 'yaml', html: 'html', css: 'css', scss: 'scss',
	less: 'less', sql: 'sql', swift: 'swift', kt: 'kotlin', toml: 'toml',
	xml: 'xml', vue: 'vue', svelte: 'svelte', lua: 'lua', r: 'r'
};

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']);

// Image extensions a vision model can actually consume as media. SVG/ICO are
// markup/container formats most models don't accept, so we inline those as text
// references instead of shipping raw bytes the model can't read.
const IMAGE_MIME_BY_EXT = {
	png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
	gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp'
};

function extOf(p) {
	const ext = path.extname(p || '');
	return ext ? ext.slice(1).toLowerCase() : '';
}

function langFor(p) {
	return LANG_BY_EXT[extOf(p)] ?? '';
}

function isImagePath(p) {
	return IMAGE_EXTS.has(extOf(p));
}

/** The image media mime type for a path the model can consume, else ''. */
function imageMimeForPath(p) {
	return IMAGE_MIME_BY_EXT[extOf(p)] ?? '';
}

/** A reference value that carries image/binary bytes (ChatReferenceBinaryData). */
function isBinaryData(v) {
	return !!v && typeof v.data === 'function' && typeof v.mimeType === 'string';
}

/** A Location: a Uri plus a Range (a selection). */
function isLocation(v) {
	return !!v && typeof v === 'object' && v.uri && v.range && typeof v.range === 'object';
}

/** A Uri-like value (file or folder). */
function isUri(v) {
	return !!v && typeof v === 'object' && !isLocation(v) && !isBinaryData(v)
		&& (typeof v.fsPath === 'string' || (typeof v.path === 'string' && typeof v.scheme === 'string'));
}

function uriFsPath(u) {
	if (!u) {
		return '';
	}
	if (typeof u.fsPath === 'string' && u.fsPath) {
		return u.fsPath;
	}
	if (u.scheme === 'file' && typeof u.path === 'string') {
		return u.path;
	}
	return '';
}

function relPath(p, dir) {
	if (dir && p.startsWith(dir)) {
		return p.slice(dir.length).replace(/^[/\\]+/, '');
	}
	return p;
}

function clampInt(n, lo, hi) {
	n = Number.isFinite(n) ? Math.trunc(n) : lo;
	if (n < lo) {
		return lo;
	}
	if (n > hi) {
		return hi;
	}
	return n;
}

/** A fenced block of file content, capped to the remaining budget. */
function fileContentBlock(rel, content, rangeLabel, budget) {
	const cap = Math.max(0, Math.min(PER_FILE_MAX_CHARS, budget));
	if (cap <= 0) {
		const text = `File: ${rel} (omitted — attachment context budget reached; read it with your tools if needed)`;
		return { text, cost: text.length, label: rel };
	}
	let body = content;
	let note = '';
	if (body.length > cap) {
		body = body.slice(0, cap);
		note = `\n… (truncated, ${content.length - cap} more characters — read the file for the rest)`;
	}
	const lang = langFor(rel);
	const header = rangeLabel ? `Selection from ${rel} (${rangeLabel}):` : `File: ${rel}`;
	const text = `${header}\n\n\`\`\`${lang}\n${body}${note}\n\`\`\``;
	return { text, cost: text.length, label: rangeLabel ? `${rel} ${rangeLabel}` : rel };
}

async function uriBlock(value, ctx) {
	const fsPath = uriFsPath(value);
	if (!fsPath) {
		return null;
	}
	const rel = relPath(fsPath, ctx.projectDir);
	const kind = await ctx.fs.stat(fsPath);
	if (kind === 'directory') {
		let entries = [];
		try { entries = await ctx.fs.list(fsPath); } catch { /* unreadable dir */ }
		const shown = entries.slice(0, MAX_DIR_ENTRIES);
		const more = entries.length > shown.length
			? `\n- … (${entries.length - shown.length} more)`
			: '';
		const listing = shown.length ? shown.map((e) => `- ${e}`).join('\n') : '- (empty)';
		const text = `Folder: ${rel}/\n${listing}${more}`;
		return { text, cost: text.length, label: `${rel}/` };
	}
	if (isImagePath(fsPath)) {
		// Ship the actual bytes as a media `file` part so a vision model can see
		// the image directly (parity with pasted/dragged images). Formats a model
		// can't read (svg/ico) fall through to a plain reference note.
		const mime = imageMimeForPath(fsPath);
		if (mime && typeof ctx.fs.readBytes === 'function') {
			try {
				const bytes = await ctx.fs.readBytes(fsPath);
				const b64 = Buffer.from(bytes).toString('base64');
				return {
					filePart: { type: 'file', mime, filename: path.basename(fsPath), url: `data:${mime};base64,${b64}` },
					label: rel
				};
			} catch { /* fall through to the reference note */ }
		}
		const text = `Image file attached: ${rel} (open it with your tools to view).`;
		return { text, cost: text.length, label: rel };
	}
	let content;
	try {
		content = await ctx.fs.readText(fsPath);
	} catch {
		const text = `File: ${rel} (could not be read)`;
		return { text, cost: text.length, label: rel };
	}
	return fileContentBlock(rel, content, null, ctx.budget);
}

async function locationBlock(value, ctx) {
	const fsPath = uriFsPath(value.uri);
	if (!fsPath) {
		return null;
	}
	const rel = relPath(fsPath, ctx.projectDir);
	let content;
	try {
		content = await ctx.fs.readText(fsPath);
	} catch {
		return null;
	}
	const lines = content.split('\n');
	const r = value.range || {};
	const startLine = clampInt(r.start && r.start.line, 0, Math.max(0, lines.length - 1));
	let endLine = clampInt(r.end && r.end.line, startLine, Math.max(0, lines.length - 1));
	// A selection that ends at column 0 of a later line doesn't actually include
	// that trailing line (matches how editors report full-line selections).
	if (r.end && r.end.character === 0 && endLine > startLine) {
		endLine -= 1;
	}
	const slice = lines.slice(startLine, endLine + 1).join('\n');
	const rangeLabel = startLine === endLine ? `line ${startLine + 1}` : `lines ${startLine + 1}–${endLine + 1}`;
	return fileContentBlock(rel, slice, rangeLabel, ctx.budget);
}

async function binaryToFilePart(value) {
	const mime = value.mimeType || 'application/octet-stream';
	// Only images are useful to the model as media; skip other binaries.
	if (!/^image\//.test(mime)) {
		return null;
	}
	let bytes;
	try {
		bytes = await value.data();
	} catch {
		return null;
	}
	const b64 = Buffer.from(bytes).toString('base64');
	const ext = (mime.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
	return { type: 'file', mime, filename: `attachment.${ext}`, url: `data:${mime};base64,${b64}` };
}

/**
 * Recognize VS Code's terminal-command attachment, whose value is a string of
 * the form `Command: <cmd>\nOutput:\n<output>\nExit Code: <n>` (see core
 * `TerminalContext.asValue`). Returns the parsed pieces, or null if it isn't one.
 * @param {string} value
 * @returns {{ command: string, output: string, exitCode: number | null } | null}
 */
function parseTerminalAttachment(value) {
	if (typeof value !== 'string' || !value.startsWith('Command: ')) {
		return null;
	}
	const lines = value.split('\n');
	const outputIdx = lines.findIndex((l) => l === 'Output:');
	const exitIdx = lines.findIndex((l) => /^Exit Code:\s*-?\d+\s*$/.test(l));
	if (outputIdx < 0 && exitIdx < 0) {
		return null; // a plain string that merely starts with "Command: "
	}
	const cmdEnd = outputIdx >= 0 ? outputIdx : exitIdx;
	const command = [lines[0].slice('Command: '.length), ...lines.slice(1, cmdEnd)].join('\n').trim();
	let output = '';
	if (outputIdx >= 0) {
		const outEnd = exitIdx > outputIdx ? exitIdx : lines.length;
		output = lines.slice(outputIdx + 1, outEnd).join('\n');
	}
	let exitCode = null;
	if (exitIdx >= 0) {
		const m = /^Exit Code:\s*(-?\d+)/.exec(lines[exitIdx]);
		if (m) {
			exitCode = parseInt(m[1], 10);
		}
	}
	return { command, output, exitCode };
}

/** A fenced block for a terminal-command attachment, capped to the budget. */
function terminalBlock(parsed, budget) {
	const cap = Math.max(0, Math.min(PER_FILE_MAX_CHARS, budget));
	let output = parsed.output || '';
	let note = '';
	if (output.length > cap) {
		output = output.slice(output.length - cap); // keep the tail
		note = '\n… (truncated; earlier output omitted)';
	}
	const exit = parsed.exitCode === null ? '' : ` (exit ${parsed.exitCode})`;
	const cmdLabel = (parsed.command.split('\n')[0] || '').slice(0, 60);
	let text = `Terminal command${exit}:\n\n\`\`\`bash\n${parsed.command}\n\`\`\``;
	if (output.trim()) {
		text += `\n\nOutput:\n\n\`\`\`\n${output}${note}\n\`\`\``;
	}
	return { text, cost: text.length, label: `terminal: ${cmdLabel}` };
}

/** Build the default fs adapter backed by the VS Code workspace API. */
function defaultFs() {
	const uriFor = (p) => vscode.Uri.file(p);
	return {
		async stat(p) {
			try {
				const s = await vscode.workspace.fs.stat(uriFor(p));
				return (s.type & vscode.FileType.Directory) ? 'directory' : 'file';
			} catch {
				return 'unknown';
			}
		},
		async readText(p) {
			return Buffer.from(await vscode.workspace.fs.readFile(uriFor(p))).toString('utf8');
		},
		async readBytes(p) {
			return await vscode.workspace.fs.readFile(uriFor(p));
		},
		async list(p) {
			const entries = await vscode.workspace.fs.readDirectory(uriFor(p));
			return entries.map(([name, type]) => (type & vscode.FileType.Directory) ? `${name}/` : name);
		}
	};
}

/**
 * Convert a request's references into opencode message context.
 *
 * @param {readonly any[]} references `request.references`
 * @param {{ projectDir?: string, fs?: { stat: Function, readText: Function, list: Function } }} [opts]
 * @returns {Promise<{ contextText: string, fileParts: any[], summary: string }>}
 */
async function buildRequestContext(references, opts = {}) {
	const refs = Array.isArray(references) ? references : [];
	const fs = opts.fs || defaultFs();
	const projectDir = opts.projectDir || '';

	const blocks = [];
	const fileParts = [];
	const labels = [];
	let used = 0;

	for (const ref of refs) {
		const value = ref && ref.value;
		if (value == null) {
			continue;
		}
		const ctx = { fs, projectDir, budget: Math.max(0, TOTAL_MAX_CHARS - used) };
		try {
			if (isBinaryData(value)) {
				const part = await binaryToFilePart(value);
				if (part) {
					fileParts.push(part);
					labels.push(part.filename || part.mime);
				}
				continue;
			}
			if (isLocation(value)) {
				const block = await locationBlock(value, ctx);
				if (block) {
					blocks.push(block.text);
					used += block.cost;
					labels.push(block.label);
				}
				continue;
			}
			if (isUri(value)) {
				const block = await uriBlock(value, ctx);
				if (block) {
					if (block.filePart) {
						// An image file: ship the bytes as a media part, not text.
						fileParts.push(block.filePart);
						labels.push(block.label);
					} else {
						blocks.push(block.text);
						used += block.cost;
						labels.push(block.label);
					}
				}
				continue;
			}
			if (typeof value === 'string' && value.trim()) {
				// A terminal-command attachment (command + output + exit code).
				const term = parseTerminalAttachment(value);
				if (term) {
					const block = terminalBlock(term, ctx.budget);
					blocks.push(block.text);
					used += block.cost;
					labels.push(block.label);
					continue;
				}
				const label = (ref.modelDescription || ref.id || 'context').toString();
				const cap = Math.max(0, Math.min(PER_FILE_MAX_CHARS, ctx.budget));
				const body = value.length > cap ? value.slice(0, cap) + '\n… (truncated)' : value;
				const text = `Context (${label}):\n\n${body}`;
				blocks.push(text);
				used += text.length;
				labels.push(label);
			}
		} catch {
			// One bad reference must not sink the rest.
		}
	}

	const contextText = blocks.length
		? 'The user attached the following context. Use it to inform your response.\n\n'
			+ blocks.join('\n\n---\n\n')
		: '';
	const summary = labels.length ? `${labels.length} attachment(s): ${labels.join(', ')}` : '';
	return { contextText, fileParts, summary };
}

module.exports = {
	buildRequestContext,
	// Exported for unit tests.
	langFor,
	isImagePath,
	imageMimeForPath,
	isUri,
	isLocation,
	isBinaryData,
	uriFsPath,
	relPath,
	parseTerminalAttachment
};
