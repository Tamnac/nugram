import type { ContentPart, Message, ReasoningEnc } from './types';

/**
 * Convert chat-completions-style messages (buildRequestMessages output) into
 * Responses API `input` items. Tool call ids double as `call_id`s, so tool
 * results and the UI's tool plumbing match up unchanged.
 *
 * Cache markers: Anthropic per-block `cache_control` is never generated for
 * custom providers; OpenAI `prompt_cache_breakpoint` is only valid on message
 * content blocks and function_call_output parts (no per-block ttl), so markers
 * on assistant output_text parts move back to the most recent valid carrier.
 */
export function toResponsesInput(messages: Message[]): Record<string, any>[] {
	const items: Record<string, any>[] = [];
	let lastCarrier: Record<string, any> | undefined; // last part able to carry a breakpoint
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

		// Prior reasoning becomes reasoning item(s) ahead of the assistant message
		// (reasoning_content is what custom providers get; thinking is anth_local's)
		const think = (msg as any).reasoning ?? (msg as any).reasoning_content ?? (msg as any).thinking;
		const hasThink = typeof think === 'string' && think.trim().length > 0;
		const encs = (msg as any).reasoning_enc as ReasoningEnc[] | undefined;
		if (output && encs?.length) {
			// The opaque blobs are the canonical round-trip; each item carries its own
			// summary parts. Pre-parts messages fall back to the flattened display text
			// on the last item — summary must at least be [] or the API 400s.
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
		// output_text isn't a documented breakpoint carrier, and reasoning and
		// function_call items can't hold one. Assistant markers move BACK to the
		// most recent carrier, not forward — the tail breakpoint sits a few
		// messages from the end on purpose (volatile region), and implicit
		// caching covers the tail.
		if (output) {
			const bp = parts.find(p => p.prompt_cache_breakpoint)?.prompt_cache_breakpoint;
			for (const p of parts) delete p.prompt_cache_breakpoint;
			if (bp && lastCarrier && !lastCarrier.prompt_cache_breakpoint) lastCarrier.prompt_cache_breakpoint = bp;
		}
		if (toolCalls?.length) {
			// A tool-call-only turn gets no message item. Empty text parts here only
			// exist to carry a breakpoint (markBreakpoint converts empty string content),
			// and emitting an item for them would tie the item list to marker placement,
			// busting the provider's prefix cache.
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

/** Tool output, always in content-parts form so breakpoints have a stable
 *  carrier — marker presence must never change the wire shape. */
function toolOutput(content: string | ContentPart[]): Record<string, any>[] {
	const src: ContentPart[] = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
	return src.map(part =>
		part.type === 'text'
			? { type: 'input_text', text: part.text, ...((part as any).prompt_cache_breakpoint && { prompt_cache_breakpoint: (part as any).prompt_cache_breakpoint }) }
			: { type: 'input_image', image_url: part.image_url.url });
}
