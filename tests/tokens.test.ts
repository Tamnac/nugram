/**
 * Tests for model-aware token estimation (src/helpers/tokens.ts).
 *
 * Run: bun test
 */

import { describe, test, expect } from 'bun:test';
import { CPT, charsPerToken, estTokens, estTokensFromLength } from '../src/helpers/tokens';

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
