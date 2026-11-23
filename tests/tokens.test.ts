/**
 * Tests for model-aware token estimation (src/helpers/tokens.ts).
 *
 * Run: bun test
 */

import { describe, test, expect } from 'bun:test';
import { CPT, charsPerToken, estTokens, estTokensFromLength, estImageTokens, estImageChars, dataUrlImageDims, IMAGE_CHARS } from '../src/helpers/tokens';

describe('charsPerToken — anthropic', () => {
	test('new opus (>= 4.7) uses the dense ratio', () => {
		expect(charsPerToken('claude-opus-4-7')).toBe(CPT.claudeDense);
		expect(charsPerToken('claude-opus-4-8')).toBe(CPT.claudeDense);
		expect(charsPerToken('anthropic/claude-opus-5')).toBe(CPT.claudeDense);
	});

	test('older opus stays on the legacy ratio', () => {
		expect(charsPerToken('claude-opus-4-6')).toBe(CPT.claudeLegacy);
		expect(charsPerToken('opus-4-5')).toBe(CPT.claudeLegacy);
		expect(charsPerToken('opus-4-1')).toBe(CPT.claudeLegacy);
	});

	test('sonnet/fable/haiku switch at 5', () => {
		expect(charsPerToken('claude-sonnet-5')).toBe(CPT.claudeDense);
		expect(charsPerToken('claude-fable-5')).toBe(CPT.claudeDense);
		expect(charsPerToken('claude-sonnet-4-6')).toBe(CPT.claudeLegacy);
		expect(charsPerToken('sonnet-4-5')).toBe(CPT.claudeLegacy);
		expect(charsPerToken('haiku-4-5')).toBe(CPT.claudeLegacy);
	});

	test('version preceding the family name is still found', () => {
		expect(charsPerToken('anthropic/claude-3.5-sonnet')).toBe(CPT.claudeLegacy);
		expect(charsPerToken('anthropic/claude-3-opus')).toBe(CPT.claudeLegacy);
	});

	test('unversioned claude ids are assumed to be latest', () => {
		expect(charsPerToken('claude-opus-latest')).toBe(CPT.claudeDense);
		expect(charsPerToken('claude-sonnet')).toBe(CPT.claudeDense);
	});
});

describe('charsPerToken — other families', () => {
	test('matches vendor-prefixed OpenRouter ids', () => {
		expect(charsPerToken('google/gemini-3-pro')).toBe(CPT.gemini);
		expect(charsPerToken('openai/gpt-5.2')).toBe(CPT.gpt);
		expect(charsPerToken('deepseek/deepseek-v4')).toBe(CPT.deepseek);
		expect(charsPerToken('moonshotai/kimi-k2')).toBe(CPT.kimi);
		expect(charsPerToken('z-ai/glm-5')).toBe(CPT.glm);
		expect(charsPerToken('mistralai/mistral-medium-3')).toBe(CPT.mistral);
		expect(charsPerToken('qwen/qwen3.6-35b')).toBe(CPT.qwen);
		expect(charsPerToken('minimax/minimax-m3')).toBe(CPT.minimax);
		expect(charsPerToken('xiaomi/mimo-v2.5-pro')).toBe(CPT.mimo);
		expect(charsPerToken('stepfun-ai/step-3.5')).toBe(CPT.step3);
		expect(charsPerToken('inclusionai/ring-1t')).toBe(CPT.lingRing);
		expect(charsPerToken('kwaipilot/kat-coder-pro')).toBe(CPT.kat);
		expect(charsPerToken('tencent/hunyuan-t1')).toBe(CPT.hunyuan);
	});

	test('word-bounded patterns do not match inside longer names', () => {
		expect(charsPerToken('inkling-1')).toBe(CPT.inkling); // not 'ling'
		expect(charsPerToken('stepfun-ai/step-30')).toBe(CPT.default); // not 'step-3'
		expect(charsPerToken('foo/glmx-v1')).toBe(CPT.default); // not 'glm'
	});

	test('falls back to the default for unknown models', () => {
		expect(charsPerToken('some/brand-new-model')).toBe(CPT.default);
		expect(charsPerToken('')).toBe(CPT.default);
	});
});

describe('estTokens', () => {
	test('rounds up and scales with the model ratio', () => {
		const text = 'x'.repeat(100);
		expect(estTokens(text, 'claude-opus-5')).toBe(Math.ceil(100 / CPT.claudeDense));
		expect(estTokens(text, 'moonshotai/kimi-k2')).toBe(Math.ceil(100 / CPT.kimi));
		expect(estTokens('', 'claude-opus-5')).toBe(0);
	});

	test('estTokensFromLength agrees with estTokens', () => {
		const text = 'hello world, this is a test string';
		for (const model of ['claude-opus-5', 'google/gemini-3-pro', 'unknown'])
			expect(estTokensFromLength(text.length, model)).toBe(estTokens(text, model));
	});
});

describe('estImageTokens', () => {
	test('claude: 28px visual patches', () => {
		expect(estImageTokens(1568, 1568, 'claude-opus-5')).toBe(56 * 56);
		expect(estImageTokens(1000, 1000, 'claude-sonnet-5')).toBe(36 * 36);
	});

	test('gemini: flat 258 under 384px, else 768px tiles', () => {
		expect(estImageTokens(384, 384, 'google/gemini-3-pro')).toBe(258);
		expect(estImageTokens(512, 512, 'google/gemini-3-pro')).toBe(258);
		expect(estImageTokens(768, 1536, 'google/gemini-3-pro')).toBe(258 * 2);
		expect(estImageTokens(1568, 1568, 'google/gemini-3-pro')).toBe(258 * 9); // ceil(1568/768)=3 per dim
	});

	test('gpt-5 patch math with multipliers', () => {
		// 1568x1568 → 49x49 = 2401 patches, under the 2500 budget
		expect(estImageTokens(1568, 1568, 'openai/gpt-5.2')).toBe(2401);
		expect(estImageTokens(512, 512, 'openai/gpt-5.2')).toBe(16 * 16);
		expect(estImageTokens(512, 512, 'openai/gpt-5-mini')).toBe(Math.round(256 * 1.62));
		expect(estImageTokens(512, 512, 'openai/gpt-5-nano')).toBe(Math.round(256 * 2.46));
	});

	test('gpt-4o tile math', () => {
		// 512x512: scale to fit 2048 (noop), shortest side 768 (noop), 1 tile + base
		expect(estImageTokens(512, 512, 'openai/gpt-4o')).toBe(85 + 170);
		// 1568x1568 → shortest side scaled to 768 → 2x2 tiles
		expect(estImageTokens(1568, 1568, 'openai/gpt-4o')).toBe(85 + 170 * 4);
		expect(estImageTokens(1568, 1568, 'openai/o3')).toBe(75 + 150 * 4);
	});

	test('qwen-style: grid28 clamps', () => {
		expect(estImageTokens(1568, 1568, 'qwen/qwen2.5-vl-72b')).toBe(56 * 56);
		expect(estImageTokens(10, 10, 'qwen/qwen2.5-vl-72b')).toBe(4); // min clamp
		expect(estImageTokens(1568, 1568, 'xiaomi/mimo-vl-7b')).toBe(56 * 56);
		expect(estImageTokens(1568, 1568, 'moonshotai/kimi-k2.5')).toBe(56 * 56);
		expect(estImageTokens(1568, 1568, 'z-ai/glm-4.5v')).toBe(56 * 56);
		expect(estImageTokens(1568, 1568, 'qwen/qwen3-vl-8b')).toBe(49 * 49); // 32px grid
		expect(estImageTokens(1568, 1568, 'tencent/hunyuan-vl')).toBe(49 * 49);
	});

	test('mistral: capped at 1540px long edge, patch 14, merge 2', () => {
		// 1540x1540 → 110x110 patches → /4 = 3025
		expect(estImageTokens(1540, 1540, 'mistralai/mistral-small-3.1')).toBe(3025);
		// 1568 downscales to 1540
		expect(estImageTokens(1568, 1568, 'mistralai/mistral-small-3.1')).toBe(3025);
	});

	test('unknown families get the qwen-style grid', () => {
		expect(estImageTokens(1568, 1568, 'some/brand-new-vlm')).toBe(56 * 56);
	});

	test('non-positive dims are zero', () => {
		expect(estImageTokens(0, 100, 'claude-opus-5')).toBe(0);
	});
});

describe('estImageChars', () => {
	test('unknown dims fall back to IMAGE_CHARS', () => {
		expect(estImageChars(undefined, 'claude-opus-5')).toBe(IMAGE_CHARS);
	});

	test('known dims convert tokens back through cpt', () => {
		const dims = { w: 1568, h: 1568 };
		expect(estImageChars(dims, 'claude-opus-5')).toBe(Math.round(56 * 56 * CPT.claudeDense));
	});
});

describe('dataUrlImageDims', () => {
	test('parses a png header', () => {
		// 8-byte sig + IHDR len/type + 100x50 dims
		const bytes = new Uint8Array(24);
		bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // png sig
		new DataView(bytes.buffer).setUint32(16, 100);
		new DataView(bytes.buffer).setUint32(20, 50);
		const url = `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`;
		expect(dataUrlImageDims(url)).toEqual({ w: 100, h: 50 });
	});

	test('rejects non-image data urls and junk', () => {
		expect(dataUrlImageDims('data:image/svg+xml;base64,PHN2Zy8+')).toBeUndefined();
		expect(dataUrlImageDims('https://example.com/x.png')).toBeUndefined();
		expect(dataUrlImageDims('not a url')).toBeUndefined();
	});
});
