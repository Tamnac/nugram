export interface PatchOptions {
	/** Runs on the freshly parsed tree before it is compared with the live one. */
	prepare?: (root: HTMLElement) => void;
	/** Leaves `live` as it is when this returns true, for state added after rendering (resolved image sources). */
	keep?: (live: Element, next: Element) => boolean;
}

/**
 * `container.innerHTML = html` without rebuilding what did not change. Streamed text only grows at
 * its end, so earlier blocks stay the same nodes, which keeps selections, hover and clicks alive
 * and spares layout and images from being redone per chunk.
 *
 * Children are matched by position: a node of the same kind is patched in place, any other is
 * replaced. A change in the middle replaces more than needed but the result is always `html`.
 */
export function patchHtml(container: HTMLElement, html: string, { prepare, keep }: PatchOptions = {}) {
	const next = container.ownerDocument.createElement(container.tagName);
	next.innerHTML = html;
	prepare?.(next);
	patchChildren(container, next);

	function patchChildren(live: Node, source: Node) {
		let current = live.firstChild;
		for (let node = source.firstChild; node;) {
			const following = node.nextSibling;
			if (!current) {
				live.appendChild(node);
			} else {
				const after = current.nextSibling;
				if (current.nodeType === node.nodeType && current.nodeName === node.nodeName) patchNode(current, node);
				else live.replaceChild(node, current);
				current = after;
			}
			node = following;
		}
		while (current) {
			const after = current.nextSibling;
			live.removeChild(current);
			current = after;
		}
	}

	function patchNode(live: Node, source: Node) {
		if (live.nodeType !== Node.ELEMENT_NODE) {
			if (live.nodeValue !== source.nodeValue) live.nodeValue = source.nodeValue;
			return;
		}
		const liveEl = live as Element;
		const sourceEl = source as Element;
		if (keep?.(liveEl, sourceEl) || liveEl.isEqualNode(sourceEl)) return;
		patchAttributes(liveEl, sourceEl);
		patchChildren(liveEl, sourceEl);
	}
}

function patchAttributes(live: Element, source: Element) {
	for (const attr of Array.from(live.attributes))
		if (!source.hasAttributeNS(attr.namespaceURI, attr.localName)) live.removeAttributeNode(attr);
	for (const attr of Array.from(source.attributes))
		if (live.getAttributeNS(attr.namespaceURI, attr.localName) !== attr.value) live.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
}
