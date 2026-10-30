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

	test('clipped keeps reasoning only on the last 5 messages', () => {
		const msgs = Array.from({ length: 8 }, (_, i) =>
			msg('assistant', `a${i}`, { thinking: [`t${i}`] }));
		const result = buildRequestMessages(msgs, { ...defaults, provider: 'or', preserveReasoning: 'clipped' });
		expect(result.map(m => (m as any).reasoning))
			.toEqual([undefined, undefined, undefined, 't3', 't4', 't5', 't6', 't7']);
	});

	test('preserve reasoning defaults to interleaved', () => {
		const result = buildRequestMessages([
			msg('assistant', 'answer', { thinking: ['some thinking'] }),
		], { ...defaults, provider: 'or' });
		expect((result[0] as any).reasoning).toBe('some thinking');
	});

	test('reasoning_enc round-trips only for GPT models', () => {
		const encMsg = () => msg('assistant', 'answer', {
			reasoning_enc: [[{ id: 'rs_1', encrypted_content: 'ENC', summary: ['s'] }]],
		});
		const gpt = buildRequestMessages([encMsg()], { ...defaults, model: 'openai/gpt-5.2' });
		expect((gpt[0] as any).reasoning_enc).toEqual([{ id: 'rs_1', encrypted_content: 'ENC', summary: ['s'] }]);
		const other = buildRequestMessages([encMsg()], { ...defaults, model: 'claude-opus-4' });
		expect((other[0] as any).reasoning_enc).toBeUndefined();
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

	test('tool results do not count toward prompt positions', () => {
		const result = buildRequestMessages([
			msg('user', 'do it'),
			msg('assistant', '', {
				tool_calls: [[
					{ id: 'tc1', type: 'function', function: { name: 'shell', arguments: { command: 'ls' } } },
					{ id: 'tc2', type: 'function', function: { name: 'shell', arguments: { command: 'pwd' } } },
				]],
				tool_results: [[
					{ tool_call_id: 'tc1', name: 'shell', content: 'out1' },
					{ tool_call_id: 'tc2', name: 'shell', content: 'out2' },
				]],
			}),
			msg('assistant', 'done'),
		], { ...defaults, prompts: [{ role: 'system', content: 'reminder', position: 2 }] });
		expect(result.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'system', 'assistant']);
		expect(result[4].content).toBe('reminder');
	});

	test('prompt position landing on a tool block goes after it, not inside', () => {
		const result = buildRequestMessages([
			msg('assistant', '', {
				tool_calls: [[{ id: 'tc1', type: 'function', function: { name: 'shell', arguments: { command: 'ls' } } }]],
				tool_results: [[
					{ tool_call_id: 'tc1', name: 'shell', content: 'out1' },
					{ tool_call_id: 'tc2', name: 'shell', content: 'out2' },
				]],
			}),
			msg('user', 'next'),
		], { ...defaults, prompts: [{ role: 'system', content: 'reminder', position: 1 }] });
		expect(result.map(m => m.role)).toEqual(['assistant', 'tool', 'tool', 'system', 'user']);
	});

	test('nested run results count once per run call toward prompt anchors', () => {
		const result = buildRequestMessages([
			msg('user', 'do it'),
			msg('assistant', '', {
				tool_calls: [[
					{ id: 'r.0', type: 'function', function: { name: 'shell', arguments: { step: 0, command: 'ls' } }, parent: 'r' },
					{ id: 'r.1', type: 'function', function: { name: 'shell', arguments: { step: 1, command: 'pwd' } }, parent: 'r' },
					{ id: 'n', type: 'function', function: { name: 'shell', arguments: { command: 'id' } } },
				]],
				tool_results: [[
					{ tool_call_id: 'r.0', name: 'shell', content: 'out1' },
					{ tool_call_id: 'r.1', name: 'shell', content: 'out2' },
					{ tool_call_id: 'n', name: 'shell', content: 'out3' },
				]],
			}),
			msg('assistant', 'done'),
		], { ...defaults, prompts: [{ role: 'system', content: 'reminder', position: 2 }] });
		expect(result.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'system', 'assistant']);
		expect((result[2] as any).tool_call_id).toBe('r');
		expect((result[3] as any).tool_call_id).toBe('n');
	});

	test('negative positions count stored messages, not tool results', () => {
		const result = buildRequestMessages([
			msg('user', 'do it'),
			msg('assistant', '', {
				tool_calls: [[{ id: 'tc1', type: 'function', function: { name: 'shell', arguments: { command: 'ls' } } }]],
				tool_results: [[{ tool_call_id: 'tc1', name: 'shell', content: 'out' }]],
			}),
			msg('assistant', 'done'),
		], { ...defaults, prompts: [{ role: 'system', content: 'reminder', position: -2 }] });
		// -2 → before the last stored message ('done'), not before the tool result
		expect(result.map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'system', 'assistant']);
	});

	test('end-position prompt lands before the reasoning prefill, not after', () => {
		const result = buildRequestMessages([
			msg('user', 'a'),
		], {
			...defaults,
			reasoningPrefill: { enabled: true, content: 'Let me think...' },
			prompts: [{ role: 'system', content: 'reminder', position: -1 }],
		});
		expect(result.map(m => m.role)).toEqual(['user', 'system', 'assistant']);
		expect(result[2].content).toBe('Let me think...');
	});

	test('empty prompts are filtered out', () => {
		const result = buildRequestMessages([
			msg('user', 'hello'),
		], { ...defaults, prompts: [{ role: 'system', content: '  ', position: 0 }] });
		expect(result).toHaveLength(1);
	});

	// ── Cache control ────────────────────────────────────────────

	test('GPT-5.6 uses explicit breakpoints on every provider', () => {
		const result = buildRequestMessages([
			msg('user', 'hello'),
		], {
			...defaults,
			provider: 'fireworks',
			cache: 'smart',
			cacheLength: '5m',
			model: 'gpt-5.6',
			prompts: [{ role: 'system', content: 'Be helpful.', position: 0 }],
		});
		expect(result[0].content).toEqual([{ type: 'text', text: 'Be helpful.', prompt_cache_breakpoint: { mode: 'explicit' } }] as any);
		expect(result[1].content).toBe('hello');
	});

	test('GPT-5.5 does not use explicit breakpoints', () => {
		const result = buildRequestMessages([
			msg('user', 'hello'),
		], {
			...defaults,
			provider: 'fireworks',
			cache: 'smart',
			cacheLength: '5m',
			model: 'gpt-5.5',
			prompts: [{ role: 'system', content: 'Be helpful.', position: 0 }],
		});
		expect(result[0].content).toBe('Be helpful.');
	});

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

	for (const model of ['claude-sonnet-4-6', 'gpt-5.6']) {
		describe(`${model} moving prompt cache boundaries`, () => {
			const marker = model.startsWith('claude') ? 'cache_control' : 'prompt_cache_breakpoint';
			const messages = (length: number) => Array.from({ length }, (_, i) => msg('user', `m${i + 1}`));
			const prompt = (position: number) => ({ role: 'system' as const, content: `prompt(${position})`, position });
			const build = (chat: ChatMessage[], prompts: BuildRequestOptions['prompts'], prefill = false) =>
				buildRequestMessages(chat, {
					...defaults, model, cache: 'smart', prompts,
					reasoningPrefill: { enabled: prefill, content: 'prefill' },
				});
			const marked = (result: ReturnType<typeof buildRequestMessages>) => result.flatMap(m =>
				Array.isArray(m.content) && m.content.some(part => marker in part)
					? m.content.filter(part => part.type === 'text').map(part => part.text) : []);

			test('keeps existing markers without moving prompts', () => {
				expect(marked(build(messages(40), [prompt(0)]))).toEqual(['prompt(0)', 'm20', 'm36']);
				expect(marked(build(messages(5), []))).toEqual([]);
			});

			test('shallow prompts keep the fifth-from-end marker; deeper prompts constrain it', () => {
				expect(marked(build(messages(10), [prompt(-1)]))).toEqual(['m7']);
				expect(marked(build(messages(10), [prompt(-5)]))).toEqual(['m6']);
				expect(marked(build(messages(10), [prompt(-8)]))).toEqual(['m3']);
			});

			test('multiple prompts stop caching before the earliest moving prompt', () => {
				expect(marked(build(messages(10), [prompt(-1), prompt(0), prompt(-4), prompt(-4)])))
					.toEqual(['prompt(0)', 'm7']);
			});

			test('deep prompts exclude midpoint markers and prompts clamped to the start', () => {
				expect(marked(build(messages(40), [prompt(0), prompt(-30)]))).toEqual(['prompt(0)', 'm11']);
				expect(marked(build(messages(10), [prompt(-100), prompt(0)]))).toEqual([]);
				expect(marked(build(messages(10), [prompt(0), prompt(-100)]))).toEqual(['prompt(0)']);
				expect(marked(build(messages(10), [prompt(-10)]))).toEqual(['m1']);
			});

			test('uses expanded tool-result positions and leaves prefill last', () => {
				const chat = messages(10);
				chat[2] = msg('assistant', 'calling', {
					tool_calls: [[{ id: 'tc1', type: 'function', function: { name: 'shell', arguments: { command: 'pwd' } } }]],
					tool_results: [[{ tool_call_id: 'tc1', name: 'shell', content: 'output' }]],
				});
				const result = build(chat, [prompt(-8), prompt(-1)], true);
				expect(marked(result)).toEqual(['output']);
				expect(result.at(-1)?.content).toBe('prefill');
			});

			test('empty negative prompts do not constrain caching', () => {
				expect(marked(build(messages(10), [{ ...prompt(-100), content: ' ' }]))).toEqual(['m6']);
			});

			test('the previous cached prefix remains unchanged as the chat grows', () => {
				const prompts = [prompt(0), prompt(-8), prompt(-1)];
				const before = build(messages(10), prompts);
				const after = build(messages(12), prompts);
				const prefix = (result: typeof before) => result.slice(0, 4).map(m => ({
					role: m.role,
					content: typeof m.content === 'string' ? m.content : m.content.map(part => part.type === 'text' ? part.text : '').join(''),
				}));
				expect(marked(before)).toEqual(['prompt(0)', 'm3']);
				expect(marked(after)).toEqual(['prompt(0)', 'm5']);
				expect(prefix(after)).toEqual(prefix(before));
			});
		});
	}

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

	test('multiple images get numbered labels the UI mirrors', () => {
		const result = buildRequestMessages([
			msg('user', 'compare', { images: [['data:image/a;base64,AA', 'data:image/b;base64,BB']] }),
		], defaults);
		expect(result[0].content).toEqual([
			{ type: 'text', text: 'compare' },
			{ type: 'text', text: 'Image 1:' },
			{ type: 'image_url', image_url: { url: 'data:image/a;base64,AA' } },
			{ type: 'text', text: 'Image 2:' },
			{ type: 'image_url', image_url: { url: 'data:image/b;base64,BB' } },
		]);
	});

	test('a single image is not labelled', () => {
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
