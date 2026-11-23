import { describe, expect, test } from 'bun:test';
import { cardFromPng, convertSTCard, convertSTMacros, isSTCard, parseSTCard, parseSTChat } from '../src/helpers/stImport';

const jsonl = (...entries: object[]) => entries.map(e => JSON.stringify(e)).join('\n') + '\n';

describe('parseSTChat', () => {
	const header = { user_name: 'Ann', character_name: 'Bob', chat_metadata: {} };

	test('skips the header and takes the names as macros', () => {
		const { messages, meta } = parseSTChat(jsonl(header, { name: 'Bob', mes: 'Hi' }, { name: 'Ann', is_user: true, mes: 'Hello' }));
		expect(messages.map(m => [m.role, m.content])).toEqual([['assistant', ['Hi']], ['user', ['Hello']]]);
		expect(meta.macros).toEqual({ char: 'Bob', user: 'Ann' });
	});

	test('swipes become versions with their own reasoning, model and timing', () => {
		const { messages } = parseSTChat(jsonl(header, {
			mes: 'b',
			swipes: ['a', 'b'],
			swipe_id: 1,
			swipe_info: [
				{ extra: { reasoning: 'ra', model: 'm1' } },
				{ gen_started: '2024-01-01T00:00:00Z', gen_finished: '2024-01-01T00:00:10Z', extra: { reasoning: '', model: 'm2', reasoning_duration: 2000 } },
			],
		}));
		const m = messages[0];
		expect(m.content).toEqual(['a', 'b']);
		expect(m.currentVersionIndex).toBe(1);
		expect(m.thinking).toEqual(['ra', '']);
		expect(m.models).toEqual(['m1', 'm2']);
		expect(m.timing?.[1]).toEqual({ reasoning_time: 2000, message_time: 8000, createdAt: Date.parse('2024-01-01T00:00:00Z') });
	});

	test('a chat without a header is accepted, a bad swipe_id falls back to the first version', () => {
		const { messages, meta } = parseSTChat(jsonl({ mes: 'x', swipes: ['x'], swipe_id: 3 }));
		expect(messages[0].currentVersionIndex).toBe(0);
		expect(meta.macros).toEqual({});
	});

	test('rejects other files', () => {
		expect(() => parseSTChat('not json')).toThrow('not valid JSON');
		expect(() => parseSTChat(jsonl(header))).toThrow('no messages');
		expect(() => parseSTChat(jsonl(header, { foo: 1 }))).toThrow('Not a SillyTavern chat');
	});
});

describe('convertSTMacros', () => {
	test('converts macros and legacy placeholders', () => {
		expect(convertSTMacros('{{char}} greets {{user}} and <USER> meets <BOT>')).toBe('@@char greets @@user and @@user meets @@char');
	});
});

describe('character cards', () => {
	const v2 = {
		spec: 'chara_card_v2',
		data: {
			name: 'Bob',
			description: '{{char}} is a baker.',
			personality: 'Gruff',
			scenario: '',
			first_mes: 'Hi {{user}}, I am {{char}}.',
			alternate_greetings: ['Oh, {{user}}.'],
			mes_example: '<START>\n{{user}}: Hi\n{{char}}: Hello',
			post_history_instructions: 'Stay in character.',
			character_book: {
				entries: [
					{ keys: ['bread', 'oven'], comment: 'Bakery', content: 'The oven is old.' },
					{ keys: ['x'], comment: 'Bakery', content: 'Again.' },
					{ keys: [], content: '  ' },
				],
			},
		},
	};

	test('V1 cards are flat, V2 cards wrap their fields in data', () => {
		expect(parseSTCard(v2).name).toBe('Bob');
		expect(parseSTCard({ name: 'Flat' }).name).toBe('Flat');
		expect(() => parseSTCard({ data: {} })).toThrow('no "name"');
	});

	test('tells cards from the app\'s chat files', () => {
		expect(isSTCard(v2)).toBe(true);
		expect(isSTCard({ name: 'Flat' })).toBe(true);
		expect(isSTCard({ messages: [], name: 'x' })).toBe(false);
		expect(isSTCard([{ role: 'user', content: 'hi' }])).toBe(false);
		expect(isSTCard(null)).toBe(false);
	});

	test('becomes prompts, a greeting chat and lore', () => {
		const { config, chat, lore } = convertSTCard(parseSTCard(v2), 'Ann');
		expect(config.prompts.map(p => [p.name, p.position])).toEqual([
			['Description', 0], ['Personality', 0], ['Example 1', 0], ['Example 1.1', 0], ['Example 1.2', 0], ['End of examples', 0], ['Post-history instructions', -1],
		]);
		expect(config.prompts[0]!.content).toBe('@@char is a baker.');
		expect(config.prompts.slice(2, 6).map(p => [p.role, p.content])).toEqual([
			['system', '[Example chat]'], ['user', 'Hi'], ['assistant', 'Hello'], ['system', '[Start a new chat]'],
		]);
		expect(chat.messages[0]!.content).toEqual(['Hi Ann, I am Bob.', 'Oh, Ann.']);
		expect(chat.macros).toEqual({ char: 'Bob', user: 'Ann' });
		expect(lore).toEqual([
			{ name: 'Bakery', description: 'Keys: bread, oven', content: 'The oven is old.' },
			{ name: 'Bakery (2)', description: 'Keys: x', content: 'Again.' },
		]);
	});

	test('example messages: multi-line turns, several blocks, the card name as speaker, no speakers', () => {
		const examples = (mes_example: string) => convertSTCard({ name: 'Bob', mes_example }).config.prompts;
		const turns = examples('<START>\n{{user}}: one\n\nmore\nBob: two\n<START>\n<USER>: three').filter(p => p.role !== 'system');
		expect(turns.map(p => [p.role, p.content])).toEqual([['user', 'one\n\nmore'], ['assistant', 'two'], ['user', 'three']]);

		const plain = examples('just some text, with a {{char}}');
		expect(plain.map(p => [p.role, p.content])).toEqual([['system', 'Example messages:\njust some text, with a @@char']]);
	});

	test('reads the card from a PNG text chunk', () => {
		const chunk = (type: string, data: Uint8Array) => {
			const out = new Uint8Array(12 + data.length);
			new DataView(out.buffer).setUint32(0, data.length);
			out.set(new TextEncoder().encode(type), 4);
			out.set(data, 8);
			return out;
		};
		const text = new TextEncoder().encode('chara\0' + btoa(JSON.stringify(v2)));
		const parts = [new Uint8Array(8), chunk('IHDR', new Uint8Array(13)), chunk('tEXt', text), chunk('IEND', new Uint8Array())];
		const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
		let at = 0;
		for (const p of parts) { png.set(p, at); at += p.length; }
		expect(parseSTCard(cardFromPng(png)).name).toBe('Bob');
		expect(() => cardFromPng(png.subarray(0, 8 + 25))).toThrow('No character data');
	});
});
