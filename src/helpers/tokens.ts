/**
 * Model-aware token estimation.
 *
 * Tokenizers differ enough between model families that a single chars-per-token
 * constant is off by ~50% at the extremes (Claude 5 packs ~2.6 chars/token,
 * Trinity ~4.3). Ratios below were measured on a prose+code README.
 *
 * "chars" means JS string length (UTF-16 code units), so non-BMP characters
 * count as 2 — calibrate against `str.length`, not file bytes.
 */

/** Measured chars-per-token, one entry per family the matchers below route to. */
export const CPT = {
	claudeDense: 2.6,
	claudeLegacy: 3.5,
	gemini: 3.75,
	gpt: 4,
	deepseek: 3.3,
	kimi: 4.2,
	glm: 4,
	mistral: 3.35,
	laguna: 4,
	trinity: 4.3,
	step3: 3.3,
	qwen: 3.85,
	minimax: 4.05,
	mimo: 4.05,
	kat: 3.85,
	inkling: 4.05,
	hunyuan: 4,
	lingRing: 3.4,
	default: 3.8,
} as const;

/**
 * Anthropic families whose tokenizer changed; second element is the version at
 * which `claudeDense` starts. Patterns must stay capture-group free (see `versionNear`).
 */
const CLAUDE_NEW_FROM: [RegExp, number][] = [
	[/opus/i, 4.7],
	[/sonnet|fable|mythos|haiku/i, 5],
];

/** First match wins, so order matters. */
const RATIOS: [RegExp, number][] = [
	[/gemini/i, CPT.gemini],
	[/\bgpt|\bo[1-9]\b|\bcodex/i, CPT.gpt], // `o[1-9]` won't cover a future o10
	[/deepseek/i, CPT.deepseek],
	[/kimi/i, CPT.kimi],
	[/\bglm\b/i, CPT.glm],
	[/mistral|magistral|devstral|ministral/i, CPT.mistral],
	[/laguna/i, CPT.laguna],
	[/trinity/i, CPT.trinity],
	[/\bstep-?3(\.\d+)?\b/i, CPT.step3],
	[/qwen/i, CPT.qwen],
	[/minimax/i, CPT.minimax],
	[/mimo/i, CPT.mimo],
	[/\bkat\b/i, CPT.kat],
	[/inkling/i, CPT.inkling],
	[/\bhunyuan|\bhy3\b/i, CPT.hunyuan],
	[/\b(ring|ling)\b/i, CPT.lingRing],
];

/**
 * Pull the version sitting next to a family name, tolerating every id shape in
 * the wild: `claude-opus-4-6`, `anthropic/claude-opus-4.7`, `claude-3.5-sonnet`.
 * Returns null when the id carries no version — new releases tend to drop the
 * suffix, so callers treat that as "latest".
 */
function versionNear(model: string, family: RegExp): number | null {
	// m[1]/m[2] are the version groups, which assumes `family` has no captures of its own.
	const num = (m: RegExpMatchArray) => parseFloat(m[2] !== undefined ? `${m[1]}.${m[2]}` : m[1]);
	// Wrapped: family patterns contain alternations that would otherwise swallow the version part.
	const fam = `(?:${family.source})`;
	const after = model.match(new RegExp(fam + String.raw`[-_ .]*v?(\d+)(?:[-.](\d+))?`, 'i'));
	if (after) return num(after);
	const before = model.match(new RegExp(String.raw`(\d+)(?:[-.](\d+))?[-_ .]*` + fam, 'i'));
	return before ? num(before) : null;
}

/** Estimated characters per token for `model`. */
export function charsPerToken(model: string): number {
	if (/claude|sonnet|opus|fable|mythos|haiku/i.test(model)) {
		for (const [family, newFrom] of CLAUDE_NEW_FROM) {
			if (!family.test(model)) continue;
			const v = versionNear(model, family);
			return v === null || v >= newFrom ? CPT.claudeDense : CPT.claudeLegacy;
		}
		return CPT.claudeLegacy;
	}

	for (const [pattern, cpt] of RATIOS)
		if (pattern.test(model)) return cpt;

	return CPT.default;
}

/** Estimated token count of `text` for `model`. */
export function estTokens(text: string, model: string): number {
	return Math.ceil(text.length / charsPerToken(model));
}

/**
 * Rough char-equivalent of one attached image, for the input's context estimate.
 * Real cost is tile-based and provider-specific; this lands near ~1k tokens.
 */
export const IMAGE_CHARS = 4000;

/** Same as `estTokens` but for a length that was already summed up. */
export function estTokensFromLength(length: number, model: string): number {
	return Math.ceil(length / charsPerToken(model));
}
