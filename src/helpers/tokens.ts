/**
 * Model-aware token estimation.
 * measured on a prose+code README.
 * "chars" means JS string length (UTF-16 code units), so non-BMP characters count as 2.
 */

/** Measured chars-per-token */
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
 * Extracts model version number
 * Returns null when the id has no version. Interpret null = latest version.
 */
function versionNear(model: string, family: RegExp): number | null {
	// The version capture groups must be m[1] and m[2], so `family` cannot contain capture groups.
	const num = (m: RegExpMatchArray) => parseFloat(m[2] !== undefined ? `${m[1]}.${m[2]}` : m[1]);
	// Use a non-capturing group so the version requirements apply to every alternative in `family`.
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
 * Char-equivalent of one attached image of unknown dimensions, for the input's context
 * estimate. Real cost is dimension-based (see estImageTokens) and provider-specific;
 * a typical ≤1568px stored image lands around 1-2.5k tokens.
 */
export const IMAGE_CHARS = 4000;

/** Same as `estTokens` but for a length that was already summed up. */
export function estTokensFromLength(length: number, model: string): number {
	return Math.ceil(length / charsPerToken(model));
}

/** Pixel dimensions of an image as sent to the provider (post-compression). */
export interface ImageDims {
	w: number;
	h: number;
}

const clampTokens = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const grid = (cell: number) => (w: number, h: number) => Math.ceil(w / cell) * Math.ceil(h / cell);
/** 14px ViT patch + 2×2 merge — the Qwen2.5-VL lineage; also Claude's documented visual patch. */
const grid28 = grid(28);

/** 16px patch + 2×2 merge — Qwen3-VL, HunyuanVL. */
const grid32 = grid(32);

// Tile-based (GPT-4o/4.1/4.5, o1, o3): fit 2048², shortest side to 768, 512px tiles + base.
function oaiTile(w: number, h: number, model: string): number {
	let s = Math.min(1, 2048 / Math.max(w, h));
	s *= Math.min(1, 768 / Math.min(w * s, h * s));
	const tiles = Math.ceil((w * s) / 512) * Math.ceil((h * s) / 512);
	const [base, tile] = /gpt-4o-mini/i.test(model) ? [2833, 5667] : /(^|[/\s-])o[13](-|$)/i.test(model) ? [75, 150] : [85, 170];
	return base + tile * tiles;
}

// (GPT-5.x, gpt-4.1-mini/nano, o4-mini) 32px patches, multipliers per size tier.Patch budgets vary by model (1536 on gpt-5, 2500 on gpt-5.4/5.5 high, uncapped on 5.6's default 'original') 2500 covers all possible ≤1568px.
function oaiPatch(w: number, h: number, model: string): number {
	const mult = /nano/i.test(model) ? 2.46 : /o4-mini/i.test(model) ? 1.72 : /mini/i.test(model) ? 1.62 : 1;
	return Math.round(Math.min(grid32(w, h), 2500) * mult);
}

/** First match wins. Sources: provider docs + the models' own HF preprocessor_config.json values. */
const IMAGE_ESTIMATORS: [RegExp, (w: number, h: number, model: string) => number][] = [
	// gemini: flat 258 when ≤384px in both dims, else 768×768 tiles × 258
	[/gemini/i, (w, h) => w <= 384 && h <= 384 ? 258 : 258 * grid(768)(w, h)],

	// tile-based: gpt-4o/4.1/4.5 and o1/o3 (o4-mini went patch-based)
	[/gpt-4o|gpt-4\.5|gpt-4\.1(-\d{4}|$)|(^|[/\s-])o[13](-|$)/i, oaiTile],
	[/\bgpt|\bo[1-9]\b|\bcodex/i, oaiPatch],

	// deepseek-vl2: 384px tiles at 14px/2 downsample (~197 each) plus a 211-token global view
	[/deepseek/i, (w, h) => 211 + 196 * Math.ceil(w / 384) * Math.ceil(h / 384) + 14 * Math.ceil(h / 384)],

	// kimi: grid28 with a 4096-token limit (MoonViT in_token_limit)
	[/kimi/i, (w, h) => Math.min(grid28(w, h), 4096)],

	// glm-4v: grid28 over an area clamp (12544..9633792 px ⇒ 16..12288 tokens)
	[/\bglm\b/i, (w, h) => clampTokens(grid28(w, h), 16, 12288)],

	// mistral pixtral: native res capped at 1540px long edge, patch 14, spatial merge 2
	[/mistral|magistral|devstral|ministral|pixtral/i, (w, h) => {
		const s = Math.min(1, 1540 / Math.max(w, h));
		return Math.ceil(Math.ceil((w * s) / 14) * Math.ceil((h * s) / 14) / 4);
	}],

	[/qwen-?3|qw3/i, (w, h) => clampTokens(grid32(w, h), 64, 16384)],

	// qwen2.x-vl and mimo-vl share the same Qwen2VLImageProcessor config
	[/qwen|mimo/i, (w, h) => clampTokens(grid28(w, h), 4, 16384)],

	// minimax vl-01 anyres: LLaVA-NeXT-style 336px crops (576 tokens each) + a thumbnail
	[/minimax/i, (w, h) => {
		const pin = (n: number) => [2016, 1680, 1344, 1008, 672, 336].find(p => p <= n) ?? 336;
		return 576 * ((pin(w) / 336) * (pin(h) / 336) + 1);
	}],

	// step3: square-pad, cap 3024, 504px windows (~83 tokens each) + ~171-token overview
	[/\bstep-?3(\.\d+)?\b/i, (w, h) => {
		const n = Math.ceil(Math.min(Math.max(w, h), 3024) / 504);
		return 83 * n * n + 171 + (n - 1);
	}],

	[/\bhunyuan|\bhy3\b/i, (w, h) => clampTokens(grid32(w, h), 256, 16384)],
];

/**
 * Estimated vision-token cost of one w×h image for `model`. Unknown families get the
 * Qwen2.5-VL-style 14px/merge-2 grid — common among open VLMs.
 */
export function estImageTokens(w: number, h: number, model: string): number {
	if (w <= 0 || h <= 0) return 0;
	if (/claude|sonnet|opus|fable|mythos|haiku/i.test(model)) return grid28(w, h);

	for (const [pattern, estimate] of IMAGE_ESTIMATORS)
		if (pattern.test(model)) return estimate(w, h, model);
	
	return Math.max(4, grid28(w, h));
}

/** Char-equivalent of one image. IMAGE_CHARS when dimensions unknown. */
export function estImageChars(dims: ImageDims | undefined, model: string): number {
	if (!dims) return IMAGE_CHARS;
	return Math.round(estImageTokens(dims.w, dims.h, model) * charsPerToken(model));
}

/**
 * Width/height parsed from `data:` URL's header bytes without decoding. Returns undefined for anything unrecognized or SVG.
 */
export function dataUrlImageDims(url: string): ImageDims | undefined {
	const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]{0,8192})/i.exec(url);
	if (!m) return undefined;
	let b: Uint8Array;
	try {
		b = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
	} catch {
		return undefined;
	}
	const u16be = (i: number) => (b[i] << 8) | b[i + 1];
	const u16le = (i: number) => b[i] | (b[i + 1] << 8);

	switch (m[1].toLowerCase()) {
		case 'png':
			return b.length >= 24
				? { w: (b[16] << 24 | b[17] << 16 | b[18] << 8 | b[19]) >>> 0, h: (b[20] << 24 | b[21] << 16 | b[22] << 8 | b[23]) >>> 0 }
				: undefined;

		case 'gif':
			return b.length >= 10 ? { w: u16le(6), h: u16le(8) } : undefined;

		case 'webp': {
			if (b.length < 30) return undefined;
			const fourcc = String.fromCharCode(b[12], b[13], b[14], b[15]);
			if (fourcc === 'VP8 ') return { w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff };
			if (fourcc === 'VP8L') return { w: 1 + (b[21] | ((b[22] & 0x3f) << 8)), h: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)) };
			if (fourcc === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
			return undefined;
		}

		default: // jpeg: walk marker segments to the first SOF
			for (let i = 2; i + 9 < b.length;) {
				if (b[i] !== 0xff) { i++; continue; }
				const marker = b[i + 1];
				if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
					return { w: u16be(i + 7), h: u16be(i + 5) };
				i += 2 + u16be(i + 2);
			}
			return undefined;
	}
}
