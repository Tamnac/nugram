// Fake OpenAI-compatible chat completions server that streams markdown from mds/*.md.
// For trying out streaming UI changes without a real provider.
//
//   bun scripts/fake_provider.ts [port]        (default port 8085)
//
// Add a custom provider with URL http://localhost:8085/v1/chat/completions (any model name, no key).
// The last user message controls the reply:
//   first number   tokens per second (default 60)
//   second number  reply length in tokens (default 1500)
//   third number   paragraph to start from, for the same text across runs (random by default)
//   "think"        stream reasoning before the reply
// e.g. "20", "150 4000", "think 80", "60 1500 7".

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const PORT = Number(process.argv[2]) || 8085;
const MDS = join(import.meta.dir, '..', 'mds');
const source = readdirSync(MDS).filter(f => f.endsWith('.md')).map(f => readFileSync(join(MDS, f), 'utf8')).join('\n\n');

// Word pieces of roughly real token size (~4 chars), so a given speed sends a varying number of characters
const TOKEN_RE = /\s?[A-Za-z]{1,6}|\s?\d{1,3}|\n+|[ \t]+|[^\sA-Za-z\d]/g;
const corpus = source.match(TOKEN_RE) ?? [];
const paragraphStarts = corpus.flatMap((t, i) => t.includes('\n\n') ? [i + 1] : []);

const CORS = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** count consecutive tokens starting at the given paragraph, or a random one. */
function excerpt(count: number, paragraph?: number): string[] {
	const n = paragraphStarts.length;
	let at = paragraphStarts[paragraph === undefined ? Math.floor(Math.random() * n) : paragraph % n] ?? 0;
	const out: string[] = [];
	while (out.length < count) {
		out.push(...corpus.slice(at, at + count - out.length));
		at = 0;
	}
	return out;
}

function lastUserText(messages: any[]): string {
	const content = [...messages].reverse().find(m => m.role === 'user')?.content ?? '';
	return typeof content === 'string' ? content : content.map((p: any) => p.text ?? '').join(' ');
}

function stream(body: any, signal: AbortSignal): ReadableStream {
	const text = lastUserText(body.messages ?? []);
	const [tps = 60, length = 1500, paragraph] = (text.match(/\d+(\.\d+)?/g) ?? []).map(Number);
	const think = /\bthink/i.test(text);
	console.log(`${new Date().toLocaleTimeString()}  ${tps} tok/s, ${length} tokens${think ? ', thinking' : ''}`);

	const encoder = new TextEncoder();
	const id = `fake-${Date.now()}`;
	const model = body.model ?? 'fake';
	const event = (obj: object) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`);
	const chunk = (delta: object) =>
		event({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta, finish_reason: null }] });

	return new ReadableStream({
		async start(controller) {
			const phases: [field: 'reasoning_content' | 'content', tokens: string[]][] = [];
			if (think) phases.push(['reasoning_content', excerpt(Math.round(length / 4), paragraph === undefined ? undefined : paragraph + 1)]);
			phases.push(['content', excerpt(length, paragraph)]);

			// Events are scheduled at the average rate. A stall holds delivery, after which
			// the held events arrive together, as they do from real providers.
			let due = performance.now() + rand(300, 900);
			let held = 0;
			let sent = 0;
			controller.enqueue(chunk({ role: 'assistant', content: '' }));
			for (const [field, tokens] of phases) {
				for (let i = 0; i < tokens.length && !signal.aborted;) {
					const n = Math.min(tokens.length - i, [1, 1, 1, 1, 2, 2, 3, 4][Math.floor(Math.random() * 8)]!);
					due += n / tps * 1000 * rand(0.4, 1.6);
					if (Math.random() < 0.01) held = performance.now() + rand(200, 900);
					const wait = Math.max(due, held) - performance.now();
					if (wait > 0) await sleep(wait);
					controller.enqueue(chunk({ [field]: tokens.slice(i, i + n).join('') }));
					i += n;
					sent += n;
				}
			}
			if (signal.aborted) return;
			const promptTokens = Math.round(JSON.stringify(body.messages ?? []).length / 4);
			controller.enqueue(event({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
			controller.enqueue(event({ id, object: 'chat.completion.chunk', model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: sent, total_tokens: promptTokens + sent } }));
			controller.enqueue(encoder.encode('data: [DONE]\n\n'));
			controller.close();
		},
	});
}

Bun.serve({
	port: PORT,
	idleTimeout: 0,
	async fetch(req) {
		const { pathname } = new URL(req.url);
		if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
		if (pathname.endsWith('/models'))
			return Response.json({ object: 'list', data: [{ id: 'fake', object: 'model', owned_by: 'fake' }] }, { headers: CORS });
		if (req.method === 'POST' && pathname.endsWith('/chat/completions'))
			return new Response(stream(await req.json(), req.signal), {
				headers: { ...CORS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
			});
		return new Response('not found', { status: 404, headers: CORS });
	},
});

console.log(`Fake provider on http://localhost:${PORT}/v1/chat/completions (${corpus.length} tokens of text)`);
