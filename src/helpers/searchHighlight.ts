import { createSearchPattern, normalizedSearchMatches, toolsMatch } from './search';
import { getMessageContent, getMessageThinking } from './messages';
import type { ChatMessage } from './types';

const blockTags = new Set([
	'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT',
	'FIGCAPTION', 'FIGURE', 'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER',
	'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE',
	'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL',
]);
const excluded = 'button, script, style, textarea, svg, math, [hidden], [aria-hidden="true"], .katex';

/** Keep matches within text blocks, but allow them to span inline formatting. */
export function searchHighlightRanges(root: HTMLElement, query: string, normalized = false): Range[] {
	if (!query) return [];
	const pattern = createSearchPattern(query);
	const ranges: Range[] = [];
	let nodes: Text[] = [];

	function flush() {
		const text = nodes.map(node => node.data).join('');
		let nodeIndex = 0;
		let nodeStart = 0;
		const matches = normalized ? normalizedSearchMatches(text, query)
			: Array.from(text.matchAll(pattern), match => ({ start: match.index, end: match.index + match[0].length }));
		for (const match of matches) {
			while (nodeStart + nodes[nodeIndex].length <= match.start) {
				nodeStart += nodes[nodeIndex++].length;
			}
			const range = root.ownerDocument.createRange();
			range.setStart(nodes[nodeIndex], match.start - nodeStart);
			while (nodeStart + nodes[nodeIndex].length < match.end) {
				nodeStart += nodes[nodeIndex++].length;
			}
			range.setEnd(nodes[nodeIndex], match.end - nodeStart);
			ranges.push(range);
		}
		nodes = [];
	}

	function visit(node: Node) {
		if (node.nodeType === Node.TEXT_NODE) {
			if ((node as Text).length) nodes.push(node as Text);
			return;
		}
		if (!(node instanceof HTMLElement)) {
			flush();
			return;
		}
		if (node.matches(excluded)) {
			flush();
			return;
		}
		const boundary = blockTags.has(node.tagName) || node.tagName === 'BR';
		if (boundary) flush();
		for (const child of node.childNodes) visit(child);
		if (boundary) flush();
	}

	visit(root);
	flush();
	return ranges;
}

/** Fallbacks only apply to fields with a raw hit, never unrelated visible text. */
export function messageSearchHighlightRanges(bubble: HTMLElement, message: ChatMessage, query: string): Range[] {
	if (!query) return [];
	const pattern = createSearchPattern(query);
	const contentMatch = pattern.test(getMessageContent(message));
	pattern.lastIndex = 0;
	const thinkingMatch = pattern.test(getMessageThinking(message) || '');
	const contents = [
		...(contentMatch ? bubble.querySelectorAll<HTMLElement>('.messageContent, .messagePlaceholder') : []),
		...(thinkingMatch ? bubble.querySelectorAll<HTMLElement>('.messageThinkContent, .messageThinkLabel') : []),
		...(toolsMatch(message, query) ? bubble.querySelectorAll<HTMLElement>('.toolCallContainer .tool') : []),
	];
	const ranges = contents.flatMap(content => searchHighlightRanges(content, query));
	return ranges.length ? ranges : contents.flatMap(content => searchHighlightRanges(content, query, true));
}

/** Observe only while searching; refresh after streaming and chunk mount/unmount. */
export function highlightSearchMatches(container: HTMLElement, query: string, messages: ChatMessage[]): () => void {
	if (!query || typeof Highlight === 'undefined' || !CSS.highlights) return () => {};
	const highlight = new Highlight();
	CSS.highlights.set('chat-search', highlight);
	let frame = 0;

	function update() {
		frame = 0;
		highlight.clear();
		for (const bubble of container.querySelectorAll<HTMLElement>('[data-message-index]')) {
			const message = messages[Number(bubble.dataset.messageIndex)];
			if (!message) continue;
			for (const range of messageSearchHighlightRanges(bubble, message, query)) highlight.add(range);
		}
	}

	function schedule() {
		if (!frame) frame = requestAnimationFrame(update);
	}

	const observer = new MutationObserver(schedule);
	observer.observe(container, { childList: true, characterData: true, subtree: true });
	schedule();
	return () => {
		observer.disconnect();
		cancelAnimationFrame(frame);
		if (CSS.highlights.get('chat-search') === highlight) CSS.highlights.delete('chat-search');
	};
}
