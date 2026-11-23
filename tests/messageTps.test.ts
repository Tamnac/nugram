import { describe, expect, test } from 'bun:test';
import { messageTps } from '../src/helpers/messages';
import type { ChatMessage } from '../src/helpers/types';

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
	role: 'assistant', content: [''], currentVersionIndex: 0, ...over,
});

describe('messageTps', () => {
	test('uses provider token counts over reasoning + message time', () => {
		const m = msg({
			usage: [{ prompt_tokens: 10, message_tokens: 168, reasoning_tokens: 160, prompt_cost: 0, message_cost: 0 }],
			timing: [{ time_to_first_token: 1160, reasoning_time: 937, message_time: 680 }],
		});
		expect(messageTps(m)).toBeCloseTo(328 / 1.617, 5);
	});

	test('prefers provider counts over the stored estimate', () => {
		const m = msg({
			usage: [{ prompt_tokens: 10, message_tokens: 100, reasoning_tokens: 0, prompt_cost: 0, message_cost: 0 }],
			timing: [{ estimated_tokens: 900, message_time: 1000 }],
		});
		expect(messageTps(m)).toBe(100);
	});

	test('uses the stored estimate, unaffected by later edits to the text', () => {
		const m = msg({
			content: ['edited'],
			timing: [{ estimated_tokens: 300, reasoning_time: 500, message_time: 500 }],
		});
		expect(messageTps(m)).toBe(300);
	});

	test('estimates from stored text, including thinking and tool calls, without usage or stored estimate', () => {
		const m = msg({
			content: ['a'.repeat(100)],
			thinking: ['b'.repeat(100)],
			tool_calls: [[{ id: 'x', type: 'function', function: { name: 'tool', arguments: { k: 1 } } }]],
			models: ['deepseek-v4.1-flash'],
			timing: [{ reasoning_time: 500, message_time: 500 }],
		});
		const chars = 100 + 100 + 'tool'.length + JSON.stringify({ k: 1 }).length;
		expect(messageTps(m)).toBeCloseTo(Math.ceil(chars / 3.3), 5);
	});

	test('is undefined without timing or output', () => {
		expect(messageTps(msg({ content: ['hi'] }))).toBeUndefined();
		expect(messageTps(msg({ timing: [{ message_time: 1000 }] }))).toBeUndefined();
	});
});
