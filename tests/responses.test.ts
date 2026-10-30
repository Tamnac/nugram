import { describe, test, expect, mock, afterAll } from 'bun:test';
import { toResponsesInput } from '../src/helpers/responses';
import * as realPlatform from '../src/helpers/platform';
import { encodeRequestBody, streamChatCompletion } from '../src/helpers/streaming';
import type { Message, ContentPart } from '../src/helpers/types';

function msg(role: Message['role'], content: string | ContentPart[], extra?: Record<string, any>): Message & Record<string, any> {
	return { role, content, ...extra } as any;
}

describe('toResponsesInput', () => {
	test('basic roles become message items', () => {
		const items = toResponsesInput([
			msg('system', 'be nice'),
			msg('user', 'hello'),
			msg('assistant', 'hi'),
			// reasoning prefill: a plain trailing assistant turn
			msg('assistant', 'continued...'),
		]);
		expect(items).toEqual([
			{ type: 'message', role: 'system', content: [{ type: 'input_text', text: 'be nice' }] },
			{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi' }] },
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'continued...' }] },
		]);
	});

	test('tool calls and results pair by call_id', () => {
		const items = toResponsesInput([
			msg('assistant', '', {
				tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } }],
			}),
			msg('tool', 'file1\nfile2', { tool_call_id: 'call_1' }),
		]);
		expect(items).toEqual([
			{ type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{"cmd":"ls"}' },
			{ type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'file1\nfile2' }] },
		]);
	});

	test('prior reasoning becomes a reasoning item before the assistant message', () => {
		const items = toResponsesInput([
			msg('assistant', 'answer', { reasoning_content: 'thought hard' }),
		]);
		expect(items).toEqual([
			{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'thought hard' }] },
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
		]);
	});

	test('legacy encrypted items round-trip with ids; display text rides the last item', () => {
		const items = toResponsesInput([
			msg('assistant', 'answer', {
				reasoning_content: 'thought hard',
				reasoning_enc: [
					{ id: 'rs_1', encrypted_content: 'ENC1' },
					{ encrypted_content: 'ENC2' },
				],
			}),
		]);
		expect(items).toEqual([
			{ type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC1', summary: [] },
			{ type: 'reasoning', encrypted_content: 'ENC2', summary: [{ type: 'summary_text', text: 'thought hard' }] },
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
		]);
	});

	test('per-item summary parts round-trip verbatim', () => {
		const items = toResponsesInput([
			msg('assistant', 'answer', {
				reasoning_content: 'part a\npart b\npart c',
				reasoning_enc: [
					{ id: 'rs_1', encrypted_content: 'ENC1', summary: ['part a', 'part b'] },
					{ id: 'rs_2', encrypted_content: 'ENC2', summary: ['part c'] },
				],
			}),
		]);
		expect(items).toEqual([
			{ type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC1', summary: [{ type: 'summary_text', text: 'part a' }, { type: 'summary_text', text: 'part b' }] },
			{ type: 'reasoning', id: 'rs_2', encrypted_content: 'ENC2', summary: [{ type: 'summary_text', text: 'part c' }] },
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
		]);
	});

	test('image parts become input_image', () => {
		const items = toResponsesInput([
			msg('user', [
				{ type: 'text', text: 'look' },
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
			]),
		]);
		expect(items).toEqual([
			{ type: 'message', role: 'user', content: [
				{ type: 'input_text', text: 'look' },
				{ type: 'input_image', image_url: 'data:image/png;base64,AAA', detail: undefined },
			] },
		]);
	});

	test('prompt_cache_breakpoint is carried, anthropic markers ignored', () => {
		const items = toResponsesInput([
			msg('user', [{ type: 'text', text: 'cached', prompt_cache_breakpoint: { mode: 'explicit' } } as any]),
		]);
		expect(items[0]).toEqual({
			type: 'message', role: 'user',
			content: [{ type: 'input_text', text: 'cached', prompt_cache_breakpoint: { mode: 'explicit' } }],
		});
	});

	test('tool outputs carry breakpoints on their text parts', () => {
		const items = toResponsesInput([
			msg('tool', [{ type: 'text', text: 'out', prompt_cache_breakpoint: { mode: 'explicit' } } as any], { tool_call_id: 'call_1' }),
		]);
		expect(items).toEqual([
			{ type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'out', prompt_cache_breakpoint: { mode: 'explicit' } }] },
		]);
	});

	test('breakpoint on a tool-call-only assistant turn moves back to the previous carrier', () => {
		const bp = { mode: 'explicit' };
		const items = toResponsesInput([
			msg('user', 'poke around'),
			msg('assistant', [{ type: 'text', text: '', prompt_cache_breakpoint: bp } as any], {
				tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{}' } }],
			}),
			msg('tool', 'ok', { tool_call_id: 'call_1' }),
		]);
		expect(items).toEqual([
			{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'poke around', prompt_cache_breakpoint: bp }] },
			{ type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
			{ type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'ok' }] },
		]);
	});

	test('marker placement does not change the item structure', () => {
		const turn = (content: any) => [
			msg('user', 'poke around a bit'),
			msg('assistant', content, {
				reasoning_enc: [{ id: 'rs_1', encrypted_content: 'ENC' }],
				tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{}' } }],
			}),
			msg('tool', 'ok', { tool_call_id: 'call_1' }),
			msg('user', 'next'),
		];
		const withMarker = toResponsesInput(turn([{ type: 'text', text: '', prompt_cache_breakpoint: { mode: 'explicit' } } as any]));
		const without = toResponsesInput(turn(''));
		const strip = (items: any[]) => JSON.stringify(items, (k, v) => k === 'prompt_cache_breakpoint' ? undefined : v);
		expect(strip(withMarker)).toBe(strip(without));
		const hasMarker = (items: any[]) => items.some(i => [...(i.content ?? []), ...(i.output ?? [])].some((p: any) => p.prompt_cache_breakpoint));
		expect(hasMarker(withMarker)).toBe(true);
	});

	test('breakpoint on assistant text moves back to the preceding carrier', () => {
		const bp = { mode: 'explicit' };
		const items = toResponsesInput([
			msg('user', 'question'),
			msg('assistant', [{ type: 'text', text: 'done', prompt_cache_breakpoint: bp } as any]),
			msg('user', 'next'),
		]);
		expect(items).toEqual([
			{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question', prompt_cache_breakpoint: bp }] },
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
			{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'next' }] },
		]);
	});

	test('a carrier with its own marker is not overwritten; a marker with no carrier is dropped', () => {
		const bp1 = { mode: 'explicit' };
		const bp2 = { mode: 'explicit' };
		const items = toResponsesInput([
			msg('user', [{ type: 'text', text: 'q', prompt_cache_breakpoint: bp2 } as any]),
			msg('assistant', [{ type: 'text', text: 'done', prompt_cache_breakpoint: bp1 } as any]),
		]);
		expect(items[0]!.content[0].prompt_cache_breakpoint).toBe(bp2);

		expect(toResponsesInput([
			msg('assistant', [{ type: 'text', text: 'x', prompt_cache_breakpoint: bp1 } as any]),
		])).toEqual([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x' }] }]);
	});

	test('tool result with images becomes content parts', () => {
		const items = toResponsesInput([
			msg('tool', [
				{ type: 'text', text: 'screenshot attached' },
			{ type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } },
			], { tool_call_id: 'call_2' }),
		]);
		expect(items).toEqual([
			{ type: 'function_call_output', call_id: 'call_2', output: [
				{ type: 'input_text', text: 'screenshot attached' },
				{ type: 'input_image', image_url: 'data:image/png;base64,BBB' },
			] },
		]);
	});
});

// ── Streaming (handleResponsesEvent) ─────────────────────────────────
// Runs the real streamChatCompletion with httpFetch mocked to return Responses
// SSE events. (Mocked rather than stubbing global fetch: sibling test files
// install Tauri internals, which would otherwise route httpFetch elsewhere.)

let stubbedResponse: () => Response = () => new Response(null, { status: 200 });
let lastSentBody: any;
mock.module('../src/helpers/platform', () => ({
	...realPlatform,
	httpFetch: async (_url: string, init?: RequestInit) => {
		lastSentBody = init?.body ? JSON.parse(init.body as string) : undefined;
		return stubbedResponse();
	},
}));
afterAll(() => mock.module('../src/helpers/platform', () => realPlatform));

function streamEvents(events: any[], cb?: { onContent?: (s: string) => void; onReasoning?: (s: string) => void; onError?: (s: string) => void }, extraOptions?: Record<string, any>) {
	const text = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
	stubbedResponse = () => new Response(
		new ReadableStream({
			start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); }
		}),
		{ status: 200 }
	);
	const run = () => streamChatCompletion(
		'gpt-5.2', [{ role: 'user', content: 'hi' }], { stream: true, ...extraOptions }, 'key', 'test',
		new AbortController().signal, 'myresponder', 'https://api.example.com/v1/responses', 'responses',
		cb?.onContent, cb?.onReasoning, cb?.onError
	);
	return { run, body: () => lastSentBody };
}

describe('streamChatCompletion (responses)', () => {
	test('text and reasoning deltas, usage, finish reason and request body', async () => {
		let content = '';
		let reasoning = '';
		const { run, body } = streamEvents([
			{ type: 'response.created', response: { id: 'resp_1' } },
			{ type: 'response.reasoning_summary_text.delta', delta: 'thinking ' },
			{ type: 'response.reasoning_summary_text.delta', delta: 'hard' },
			{ type: 'response.output_text.delta', delta: 'Hello' },
			{ type: 'response.output_text.delta', delta: ' world' },
			{ type: 'response.completed', response: {
				id: 'resp_1', status: 'completed',
				usage: { input_tokens: 10, output_tokens: 7, output_tokens_details: { reasoning_tokens: 3 }, input_tokens_details: { cached_tokens: 4 } }
			} },
		], {
			onContent: s => content += s,
			onReasoning: s => reasoning += s,
		});
		const result = await run();

		expect(content).toBe('Hello world');
		expect(reasoning).toBe('thinking hard');
		expect(result.success).toBe(true);
		expect(result.id).toBe('resp_1');
		expect(result.finishReason).toBe('stop');
		expect(result.usage).toEqual({
			prompt_tokens: 10, message_tokens: 4, reasoning_tokens: 3,
			prompt_cost: 0, message_cost: 0, cached_tokens: 4
		});

		const b = body();
		expect(b.max_output_tokens).toBeNumber();
		expect(b.max_tokens).toBeUndefined();
		expect(b.store).toBe(false);
		expect(b.reasoning_effort).toBeUndefined();
		expect(b.include).toEqual(['reasoning.encrypted_content']);
		expect(b.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]);
	});

	test('reasoning effort maps to reasoning.effort with detailed summaries', async () => {
		const { run, body } = streamEvents([
			{ type: 'response.completed', response: { id: 'r', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
		], undefined, { reasoning: { effort: 'high' } });
		await run();
		expect(body().reasoning).toEqual({ effort: 'high', summary: 'detailed' });
	});

	test('reasoning items with encrypted content are captured for rehydration', async () => {
		const { run } = streamEvents([
			{ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC' } },
			{ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_2' } }, // no enc: ignored
			{ type: 'response.completed', response: { id: 'r', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
		]);
		const result = await run();
		expect(result.reasoning_enc).toEqual([{ id: 'rs_1', encrypted_content: 'ENC' }]);
	});

	test('reasoning item summaries are captured as per-item parts', async () => {
		const { run } = streamEvents([
			{ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC1',
				summary: [{ type: 'summary_text', text: 'alpha' }, { type: 'summary_text', text: 'beta' }] } },
			{ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_2', encrypted_content: 'ENC2',
				summary: [{ type: 'summary_text', text: 'gamma' }] } },
			{ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_3', encrypted_content: 'ENC3', summary: [] } },
			{ type: 'response.completed', response: { id: 'r', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
		]);
		const result = await run();
		expect(result.reasoning_enc).toEqual([
			{ id: 'rs_1', encrypted_content: 'ENC1', summary: ['alpha', 'beta'] },
			{ id: 'rs_2', encrypted_content: 'ENC2', summary: ['gamma'] },
			{ id: 'rs_3', encrypted_content: 'ENC3' },
		]);
	});

	test('function_call items become complete tool calls', async () => {
		const { run } = streamEvents([
			{ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_9', name: 'shell', arguments: '{"cmd":"ls"}' } },
			{ type: 'response.completed', response: { id: 'resp_2', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
		]);
		const result = await run();
		expect(result.toolCalls).toEqual([
			{ id: 'call_9', type: 'function', function: { name: 'shell', arguments: { cmd: 'ls' } } }
		]);
	});

	test('output-token truncation maps to the completions finish reason', async () => {
		const { run } = streamEvents([
			{ type: 'response.completed', response: { id: 'resp_3', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 1, output_tokens: 1 } } },
		]);
		const result = await run();
		expect(result.finishReason).toBe('length');
	});

	test('blank lines separate reasoning parts and items, not doubled when present', async () => {
		let reasoning = '';
		const { run } = streamEvents([
			{ type: 'response.output_item.added', item: { type: 'reasoning' } },
			{ type: 'response.reasoning_summary_text.delta', delta: 'part one' },
			{ type: 'response.reasoning_summary_part.added' },
			{ type: 'response.reasoning_summary_text.delta', delta: 'part two' },
			{ type: 'response.output_item.added', item: { type: 'reasoning' } },
			{ type: 'response.reasoning_summary_text.delta', delta: 'item two\n' },
			{ type: 'response.output_item.added', item: { type: 'reasoning' } },
			{ type: 'response.reasoning_summary_text.delta', delta: 'item three' },
			{ type: 'response.completed', response: { id: 'r', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
		], { onReasoning: s => reasoning += s });
		await run();
		expect(reasoning).toBe('part one\n\npart two\n\nitem two\n\nitem three');
	});

	test('response.failed surfaces the error', async () => {
		let error = '';
		const { run } = streamEvents([
			{ type: 'response.failed', response: { error: { code: 'server_error', message: 'boom' } } },
		], { onError: e => error = e });
		await run();
		expect(error).toBe('boom');
	});
});

describe('encodeRequestBody', () => {
	test('replaces lone surrogates, keeps pairs and escaped text', () => {
		const text = 'pair 🧪 | high \ud800 | low \udc00 | literal \\ud800';
		const sent = JSON.parse(encodeRequestBody({ messages: [{ content: text }] }));
		expect(sent.messages[0].content).toBe('pair 🧪 | high \ufffd | low \ufffd | literal \\ud800');
	});
});
