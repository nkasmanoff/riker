'use strict';
// Renders opencode's `todowrite` tool input as a Markdown checklist.
//
// opencode plans multi-step work with its todo tool, but the integration used
// to collapse those calls into a generic "TodoWrite — done" progress row, so
// the plan was invisible. Cursor's signature "agent is working through a list"
// feel comes from a visible, updating checklist — this produces that.
//
// Chat markdown is append-only (we can't mutate a prior block in place), so the
// caller renders a fresh checklist each time the list MEANINGFULLY changes
// (dedup via `todoSignature`). The result reads as progress: the plan appears,
// then re-appears with items checked off as opencode advances.

/** Pull the human-readable text off a todo item across opencode field names. */
function todoContent(t) {
	if (!t || typeof t !== 'object') {
		return '';
	}
	const raw = t.content ?? t.text ?? t.title ?? '';
	return String(raw).trim();
}

function todoStatus(t) {
	const s = t && t.status ? String(t.status) : 'pending';
	return s === 'in-progress' ? 'in_progress' : s;
}

/**
 * Render a todo array as a Markdown checklist, or '' if there's nothing to show.
 * @param {any[]} todos
 * @returns {string}
 */
function renderTodoList(todos) {
	if (!Array.isArray(todos) || todos.length === 0) {
		return '';
	}
	const lines = [];
	let done = 0;
	for (const t of todos) {
		const content = todoContent(t);
		if (!content) {
			continue;
		}
		switch (todoStatus(t)) {
			case 'completed':
				done++;
				lines.push(`- [x] ${content}`);
				break;
			case 'cancelled':
				lines.push(`- [x] ~~${content}~~`);
				break;
			case 'in_progress':
				lines.push(`- [ ] ${content} _(in progress)_`);
				break;
			default:
				lines.push(`- [ ] ${content}`);
				break;
		}
	}
	if (lines.length === 0) {
		return '';
	}
	return `\n\n**Todos · ${done}/${lines.length}**\n\n${lines.join('\n')}\n\n`;
}

/** Stable signature of a todo list so identical updates aren't re-rendered. */
function todoSignature(todos) {
	if (!Array.isArray(todos)) {
		return '';
	}
	return todos
		.map((t) => `${todoStatus(t)}:${todoContent(t)}`)
		.filter((s) => s !== 'pending:')
		.join('|');
}

module.exports = { renderTodoList, todoSignature, todoContent, todoStatus };
