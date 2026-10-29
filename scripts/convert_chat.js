// Convert a SillyTavern chat .jsonl into the app's ChatMessage[] JSON format.
// Swipes become message versions; per-swipe reasoning, model and timing are preserved.
// Usage: node scripts/convert_chat.js <input.jsonl> <output.json>
//        node scripts/convert_chat.js <input_folder> <output_folder>
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const [input, output] = process.argv.slice(2);
if (!input || !output) {
	console.error('Usage: node convert_chat.js <input.jsonl|folder> <output.json|folder>');
	process.exit(1);
}

function convert(m) {
	const content = m.swipes?.length ? m.swipes : [m.mes ?? ''];

	// Per-swipe info; fall back to top-level fields for messages without swipe_info
	const infos = m.swipe_info?.length
		? m.swipe_info
		: [{ gen_started: m.gen_started, gen_finished: m.gen_finished, extra: m.extra ?? {} }];

	const perSwipe = content.map((_, i) => infos[i] ?? {});

	const thinking = perSwipe.map(i => i.extra?.reasoning ?? '');
	const models = perSwipe.map(i => i.extra?.model ?? '');
	const timing = perSwipe.map(i => {
		const t = {};
		const ttft = i.extra?.time_to_first_token;
		const reasoning = i.extra?.reasoning_duration;
		if (ttft != null) t.time_to_first_token = ttft;
		if (reasoning != null) t.reasoning_time = reasoning;
		if (i.gen_started && i.gen_finished) {
			const total = Date.parse(i.gen_finished) - Date.parse(i.gen_started);
			t.message_time = Math.max(total - (reasoning ?? 0), 0);
		}
		return t;
	});

	const msg = {
		role: m.is_user ? 'user' : m.is_system ? 'system' : 'assistant',
		content,
		currentVersionIndex: m.swipe_id ?? 0,
	};
	if (thinking.some(t => t !== '')) msg.thinking = thinking;
	if (models.some(x => x !== '')) msg.models = models;
	if (timing.some(t => Object.keys(t).length > 0)) msg.timing = timing;
	return msg;
}

function convertFile(inFile, outFile) {
	const entries = readFileSync(inFile, 'utf8')
		.split('\n')
		.filter(l => l.trim())
		.map(l => JSON.parse(l));

	// First line is the chat header (user/character names, metadata) - skip it
	const messages = entries.slice(1).map(convert);
	writeFileSync(outFile, JSON.stringify(messages, null, 2));
	console.log(`Wrote ${messages.length} messages to ${outFile}`);
}

if (statSync(input).isDirectory()) {
	const files = readdirSync(input).filter(f => f.endsWith('.jsonl'));
	if (!files.length) {
		console.error(`No .jsonl files in ${input}`);
		process.exit(1);
	}
	mkdirSync(output, { recursive: true });
	for (const f of files)
		convertFile(join(input, f), join(output, basename(f, '.jsonl') + '.json'));
} else {
	convertFile(input, output);
}
