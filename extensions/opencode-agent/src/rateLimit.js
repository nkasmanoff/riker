'use strict';
// Detect provider rate-limit / overload signals from opencode error messages.
//
// opencode doesn't expose provider rate-limit headers directly, so the only
// reliable signal is the error text it surfaces when a turn hits a 429 / quota /
// overload. We parse that into a flag + an optional retry-after so the status
// bar can show a transient "rate limited" state instead of a silent failure.

const RATE_LIMIT_PATTERNS = [
	/rate[\s_-]?limit/i,
	/\b429\b/,
	/too many requests/i,
	/\boverloaded\b/i, // Anthropic 529
	/\b529\b/,
	/quota/i,
	/insufficient[_\s-]?quota/i
];

/**
 * @param {string} message
 * @returns {{ limited: boolean, retryAfterSec: number | null }}
 */
function parseRateLimit(message) {
	const text = typeof message === 'string' ? message : '';
	if (!text) {
		return { limited: false, retryAfterSec: null };
	}
	const limited = RATE_LIMIT_PATTERNS.some((re) => re.test(text));
	if (!limited) {
		return { limited: false, retryAfterSec: null };
	}
	return { limited: true, retryAfterSec: parseRetryAfter(text) };
}

/** Pull a retry delay (in seconds) out of common phrasings, or null. */
function parseRetryAfter(text) {
	// "retry-after: 30" / "retry after 30s"
	let m = /retry[\s-]?after[:\s]+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds|m|min|mins|minutes)?/i.exec(text);
	if (m) {
		return toSeconds(parseFloat(m[1]), m[2]);
	}
	// "try again in 2 minutes" / "please retry in 15 seconds"
	m = /(?:try again|retry)\s+in\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds|m|min|mins|minutes)?/i.exec(text);
	if (m) {
		return toSeconds(parseFloat(m[1]), m[2]);
	}
	return null;
}

function toSeconds(value, unit) {
	if (!Number.isFinite(value) || value < 0) {
		return null;
	}
	const u = (unit || 's').toLowerCase();
	if (u === 'ms') {
		return Math.max(1, Math.round(value / 1000));
	}
	if (u.startsWith('m')) {
		return Math.round(value * 60);
	}
	return Math.round(value);
}

module.exports = { parseRateLimit };
