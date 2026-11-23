import type { ContentPart, Message, ReasoningEnc } from './types';

/**
 * Convert chat-completions-style messages (buildRequestMessages output) into
 * Responses API `input` items. Tool call ids are reused as `call_id`s, so tool
 * results and the UI's tool handling need no id mapping.
 *
 * Cache markers: Anthropic per-block `cache_control` is never generated for
 * custom providers; OpenAI `prompt_cache_breakpoint` is only valid on message
 * content blocks and function_call_output parts (no per-block ttl), so a marker
 * on an assistant output_text part is moved to the most recent earlier part that
 * can hold one.
 */
export function toResponsesInput(messages: Message[]): Record<string, any>[] {
	const items: Record<string, any>[] = [];
	let lastCarrier: Record<string, any> | undefined; // last part that can hold a breakpoint
	for (const msg of messages) {
		if (msg.role === 'tool') {
			const tool = msg as Extract<Message, { role: 'tool' }>;
			const output = toolOutput(tool.content);
			lastCarrier = output[output.length - 1] ?? lastCarrier;
			items.push({
				type: 'function_call_output',
				call_id: tool.tool_call_id,
				output,
			});
			continue;
		}

		const output = msg.role === 'assistant';
		const toolCalls = (msg as any).tool_calls as any[] | undefined;

		// Prior reasoning is sent as reasoning item(s) before the assistant message
		// (custom providers get reasoning_content; anth_local gets thinking)
		const think = (msg as any).reasoning ?? (msg as any).reasoning_content ?? (msg as any).thinking;
		const hasThink = typeof think === 'string' && think.trim().length > 0;
		const encs = (msg as any).reasoning_enc as ReasoningEnc[] | undefined;
		if (output && encs?.length) {
			// The encrypted blobs are sent back unchanged, each with its own summary parts.
			// Messages stored before summary parts existed put the flattened thinking text
			// on the last item instead. `summary` must be at least [] or the API returns 400.
			encs.forEach((enc, i) => items.push({
				type: 'reasoning',
				...(enc.id && { id: enc.id }),
				encrypted_content: enc.encrypted_content,
				summary: enc.summary?.length
					? enc.summary.map(text => ({ type: 'summary_text', text }))
					: (i === encs.length - 1 && hasThink ? [{ type: 'summary_text', text: think }] : []),
			}));
		} else if (output && hasThink) {
			items.push({ type: 'reasoning', summary: [{ type: 'summary_text', text: think }] });
		}

		const parts = contentParts(msg.content, output);
		// output_text isn't documented to accept a breakpoint, and reasoning and
		// function_call items can't hold one. Assistant markers are moved to the
		// most recent earlier part, never a later one: the last breakpoint is placed
		// a few messages before the end on purpose, since the final messages change
		// between requests, and implicit caching handles those.
		if (output) {
			const bp = parts.find(p => p.prompt_cache_breakpoint)?.prompt_cache_breakpoint;
			for (const p of parts) delete p.prompt_cache_breakpoint;
			if (bp && lastCarrier && !lastCarrier.prompt_cache_breakpoint) lastCarrier.prompt_cache_breakpoint = bp;
		}
		if (toolCalls?.length) {
			// A tool-call-only turn gets no message item. Empty text parts here only
			// exist to hold a breakpoint (markBreakpoint converts empty string content).
			// Emitting an item for them would make the item list depend on where
			// breakpoints are placed, which changes the prefix and invalidates the cache.
			const visible = parts.filter(p => p.type === 'input_image' || p.text !== '');
			if (visible.length > 0) items.push({ type: 'message', role: msg.role, content: visible });
		} else {
			if (parts.length === 0) parts.push(textPart('', undefined, output));
			if (!output) lastCarrier = parts[parts.length - 1] ?? lastCarrier;
			items.push({ type: 'message', role: msg.role, content: parts });
		}

		for (const tc of toolCalls ?? [])
			items.push({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
	}
	return items;
}

function contentParts(content: string | ContentPart[], output: boolean): Record<string, any>[] {
	if (typeof content === 'string')
		return content === '' ? [] : [textPart(content, undefined, output)];
	return content.map(part =>
		part.type === 'text'
			? textPart(part.text, (part as any).prompt_cache_breakpoint, output)
			: { type: 'input_image', image_url: part.image_url.url, detail: part.image_url.detail });
}

function textPart(text: string, breakpoint: object | undefined, output: boolean): Record<string, any> {
	return {
		type: output ? 'output_text' : 'input_text',
		text,
		...(breakpoint && { prompt_cache_breakpoint: breakpoint }),
	};
}

/** Tool output, always as content parts, so adding or removing a breakpoint
 *  never changes the request's structure. */
function toolOutput(content: string | ContentPart[]): Record<string, any>[] {
	const src: ContentPart[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
	return src.map(part =>
		part.type === 'text'
			? { type: 'input_text', text: part.text, ...((part as any).prompt_cache_breakpoint && { prompt_cache_breakpoint: (part as any).prompt_cache_breakpoint }) }
			: { type: 'input_image', image_url: part.image_url.url });
}
