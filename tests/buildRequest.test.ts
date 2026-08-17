import { describe, test, expect } from 'bun:test';
import { buildRequestMessages, BuildRequestOptions } from '../src/helpers/buildRequest';
import type { ChatMessage } from '../src/helpers/types';

const defaults: BuildRequestOptions = {
	provider: 'or',
	prompts: [],
	cache: 'none',
	cacheLength: '5m',
	model: 'nonexistent-model'
};

function msg(role: ChatMessage['role'], content: string, extra?: Partial<ChatMessage>): ChatMessage {
	return { role, content: [content], currentVersionIndex: 0, ...extra };
}

describe('buildRequestMessages', () => {
	test('basic conversion', () => {
		const result = buildRequestMessages([
			msg('user', 'hello'),
			msg('assistant', 'hi'),
		], defaults);
		expect(result).toEqual([
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: 'hi' },
		]);
	});

	test('uses currentVersionIndex', () => {
		const result = buildRequestMessages([
			{ role: 'user', content: ['v0', 'v1'], currentVersionIndex: 1 },
		], defaults);
		expect(result[0].content).toBe('v1');
	});

	// ── Reasoning ────────────────────────────────────────────────

	test('preserve reasoning — openrouter uses reasoning field', () => {
		const result = buildRequestMessages([
			msg('assistant', 'answer', { thinking: ['some thinking'] }),
		], { ...defaults, provider: 'or', preserveReasoning: 'full' });
		expect((result[0] as any).reasoning).toBe('some thinking');
	});

	test('preserve reasoning — anthropic uses thinking + signature', () => {
		const result = buildRequestMessages([
			msg('assistant', 'answer', { thinking: ['some thinking'], thinking_signature: ['sig123'] }),
		], { ...defaults, provider: 'anth_local', preserveReasoning: 'full' });
		expect((result[0] as any).thinking).toBe('some thinking');
		expect((result[0] as any).thinking_signature).toBe('sig123');
	});

	test('preserve reasoning — anthropic skips without signature', () => {
		const result = buildRequestMessages([
			msg('assistant', 'answer', { thinking: ['some thinking'] }),
		], { ...defaults, provider: 'anth_local', preserveReasoning: 'full' });
		expect((result[0] as any).thinking).toBeUndefined();
	});

	test('preserve reasoning — other providers use reasoning_content', () => {
		const result = buildRequestMessages([
			msg('assistant', 'answer', { thinking: ['some thinking'] }),
		], { ...defaults, provider: 'fireworks', preserveReasoning: 'full' });
		expect((result[0] as any).reasoning_content).toBe('some thinking');
	});

	test('reasoning not preserved when off', () => {
		const result = buildRequestMessages([
			msg('assistant', 'answer', { thinking: ['some thinking'] }),
		], { ...defaults, preserveReasoning: 'off' });
		expect((result[0] as any).reasoning).toBeUndefined();
		expect((result[0] as any).reasoning_content).toBeUndefined();
		expect((result[0] as any).thinking).toBeUndefined();
	});

	// ── Tool calls & results ─────────────────────────────────────

	test('tool calls have arguments stringified', () => {
		const result = buildRequestMessages([
			msg('assistant', '', {
				tool_calls: [[{ id: 'tc1', type: 'function', function: { name: 'read_file', arguments: { path: 'foo.txt' } } }]],
			}),
		], defaults);
		expect((result[0] as any).tool_calls[0].function.arguments).toBe('{"path":"foo.txt"}');
	});

	test('UI-only tool call fields not sent to API', () => {
		const result = buildRequestMessages([
			msg('assistant', '', {
				tool_calls: [[{ id: 'tc1', type: 'function', _matchedLines: [42], function: { name: 'edit_file', arguments: { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] } } }]],
			}),
		], defaults);
		const tc = (result[0] as any).tool_calls[0];
		expect(tc._matchedLines).toBeUndefined();
		expect(Object.keys(tc).sort()).toEqual(['function', 'id', 'type']);
		expect(tc.function.arguments).toContain('"oldText":"x"');
	});

	test('tool results injected after assistant message', () => {
		const result = buildRequestMessages([
			msg('assistant', 'ok', {
				tool_results: [[{ tool_call_id: 'tc1', name: 'read_file', content: 'file contents' }]],
			}),
		], defaults);
		expect(result).toHaveLength(2);
		expect(result[1]).toEqual({ role: 'tool', content: 'file contents', tool_call_id: 'tc1', name: 'read_file' });
	});

	// ── Reasoning prefill ────────────────────────────────────────

	test('reasoning prefill appended when enabled', () => {
		const result = buildRequestMessages([
			msg('user', 'hello'),
		], { ...defaults, reasoningPrefill: { enabled: true, content: 'Let me think...' } });
		expect(result).toHaveLength(2);
		expect(result[1]).toEqual({ role: 'assistant', content: 'Let me think...' });
	});

	test('reasoning prefill skipped when last message is assistant', () => {
		const result = buildRequestMessages([
			msg('assistant', 'hi'),
		], { ...defaults, reasoningPrefill: { enabled: true, content: 'Let me think...' } });
		expect(result).toHaveLength(1);
	});

	test('reasoning prefill skipped when disabled', () => {
		const result = buildRequestMessages([
			msg('user', 'hello'),
		], { ...defaults, reasoningPrefill: { enabled: false, content: 'Let me think...' } });
		expect(result).toHaveLength(1);
	});

	// ── Prompt insertion ─────────────────────────────────────────

	test('system prompt inserted at position 0', () => {
		const result = buildRequestMessages([
			msg('user', 'hello'),
		], { ...defaults, prompts: [{ role: 'system', content: 'You are helpful.', position: 0 }] });
		expect(result[0]).toEqual({ role: 'system', content: 'You are helpful.' });
		expect(result[1].content).toBe('hello');
	});

	test('prompt inserted at negative position', () => {
		const result = buildRequestMessages([
			msg('user', 'a'),
			msg('assistant', 'b'),
			msg('user', 'c'),
		], { ...defaults, prompts: [{ role: 'system', content: 'reminder', position: -1 }] });
		// -1 → inserts at end (length + (-1) + 1 = length)
		expect(result[3]).toEqual({ role: 'system', content: 'reminder' });
		expect(result[2].content).toBe('c');
	});

	test('prompt not inserted inside tool_calls -> tool block', () => {
		const result = buildRequestMessages([
			msg('user', 'do it'),
			msg('assistant', '', {
				tool_calls: [[{ id: 'tc1', type: 'function', function: { name: 'shell', arguments: { command: 'ls' } } }]],
				tool_results: [[{ tool_call_id: 'tc1', name: 'shell', content: 'output' }]],
			}),
			msg('assistant', 'done'),
		], { ...defaults, prompts: [{ role: 'system', content: 'reminder', position: -1 }] });
		// Should not land between assistant(tool_calls) and tool result
		const roles = result.map(m => m.role);
		const toolIdx = roles.indexOf('tool');
		if (toolIdx > 0) {
			// The message before a tool result should be the assistant with tool_calls, not the injected prompt
			expect((result[toolIdx - 1] as any).tool_calls).toBeDefined();
		}
	});

	test('empty prompts are filtered out', () => {
		const result = buildRequestMessages([
			msg('user', 'hello'),
		], { ...defaults, prompts: [{ role: 'system', content: '  ', position: 0 }] });
		expect(result).toHaveLength(1);
	});

	// ── Cache control ────────────────────────────────────────────

	test('cache control applied to system prompt for anthropic providers', () => {
		const result = buildRequestMessages([
			msg('user', 'hello'),
		], {
			...defaults,
			provider: 'or',
			cache: 'smart',
			cacheLength: '5m',
			model: 'claude-sonnet-4-6',
			prompts: [{ role: 'system', content: 'Be helpful.', position: 0 }],
		});
		expect(result[0].content).toEqual([{ type: 'text', text: 'Be helpful.', cache_control: { type: 'ephemeral', ttl: '5m' } }] as any);
	});

	test('no cache control for non-anthropic providers', () => {
		const result = buildRequestMessages([
			msg('user', 'hello'),
		], {
			...defaults,
			provider: 'fireworks',
			cache: 'smart',
			prompts: [{ role: 'system', content: 'Be helpful.', position: 0 }],
		});
		expect(result[0].content).toBe('Be helpful.');
	});

	test('no cache control when cache is none', () => {
		const result = buildRequestMessages([
			msg('user', 'hello'),
		], {
			...defaults,
			provider: 'or',
			cache: 'none',
			prompts: [{ role: 'system', content: 'Be helpful.', position: 0 }],
		});
		expect(result[0].content).toBe('Be helpful.');
	});

	test('1h cache length', () => {
		const result = buildRequestMessages([
			msg('user', 'hello'),
		], {
			...defaults,
			provider: 'or',
			cache: 'smart',
			cacheLength: '1h',
			model: 'claude-sonnet-4-6',
			prompts: [{ role: 'system', content: 'Be helpful.', position: 0 }],
		});
		expect(result[0].content).toEqual([{ type: 'text', text: 'Be helpful.', cache_control: { type: 'ephemeral', ttl: '1h' } }] as any);
	});

	// ── File attachments ─────────────────────────────────────────

	test('file snapshots are prepended as direct file tags', () => {
		const result = buildRequestMessages([
			msg('user', 'review this', {
				files: [[{
					id: 'file-1', path: 'src/a.ts', chars: 40,
					data: { path: 'src/a.ts', body: 'const a = 1;', start: 0, end: 1, total: 1 },
				}]],
			}),
		], defaults);
		expect(result[0].content).toBe('<file>\nsrc/a.ts (1 lines)\n\n1│const a = 1;\n</file>\n\nreview this');
	});

	test('file attachments follow the active version', () => {
		const result = buildRequestMessages([{
			role: 'user', content: ['old', 'new'], currentVersionIndex: 1,
			files: [[], [{ id: 'file-2', path: 'b.txt', chars: 20, data: { path: 'b.txt', body: 'b', start: 0, end: 1, total: 1 } }]],
		}], defaults);
		expect(result[0].content).toBe('<file>\nb.txt (1 lines)\n\n1│b\n</file>\n\nnew');
	});

	// ── Images ───────────────────────────────────────────────────

	test('images become content parts after the text', () => {
		const result = buildRequestMessages([
			msg('user', 'what is this', { images: [['data:image/webp;base64,AAA']] }),
		], defaults);
		expect(result[0].content).toEqual([
			{ type: 'text', text: 'what is this' },
			{ type: 'image_url', image_url: { url: 'data:image/webp;base64,AAA' } },
		]);
	});

	test('image-only message omits the empty text part', () => {
		const result = buildRequestMessages([
			msg('user', '', { images: [['data:image/webp;base64,AAA']] }),
		], defaults);
		expect(result[0].content).toEqual([
			{ type: 'image_url', image_url: { url: 'data:image/webp;base64,AAA' } },
		]);
	});

	test('images follow the active version', () => {
		const result = buildRequestMessages([
			{ role: 'user', content: ['v0', 'v1'], currentVersionIndex: 1, images: [['old'], ['new']] },
		], defaults);
		expect(result[0].content).toEqual([
			{ type: 'text', text: 'v1' },
			{ type: 'image_url', image_url: { url: 'new' } },
		]);
	});

	test('a version without images sends a plain string', () => {
		const result = buildRequestMessages([
			{ role: 'user', content: ['v0', 'v1'], currentVersionIndex: 1, images: [['old'], []] },
		], defaults);
		expect(result[0].content).toBe('v1');
	});

	test('cache breakpoint lands on the last part of a message with images', () => {
		const messages = [msg('user', 'hello'), msg('assistant', 'hi')];
		for (let i = 0; i < 5; i++) messages.push(msg('user', `filler ${i}`));
		messages[messages.length - 5] = msg('user', 'look', { images: [['data:image/webp;base64,AAA']] });

		const result = buildRequestMessages(messages, {
			...defaults,
			provider: 'or',
			cache: 'smart',
			model: 'claude-sonnet-4-6',
		});
		expect(result[result.length - 5].content).toEqual([
			{ type: 'text', text: 'look' },
			{ type: 'image_url', image_url: { url: 'data:image/webp;base64,AAA' }, cache_control: { type: 'ephemeral', ttl: '5m' } },
		] as any);
	});
});
