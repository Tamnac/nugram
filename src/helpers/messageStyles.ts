/**
 * CSS from `<style>` elements in messages. Messages are rendered in chunks that leave the DOM when scrolled
 * away, so their styles are removed from the rendered HTML and applied from one element for the whole chat.
 */

const styleElementRe = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style\s*>/gi;
/** Also matches a style still being streamed: the browser would apply it to everything after it, and to the app, until it is closed. */
const openStyleRe = /<style(?:\s[^>]*)?>[\s\S]*?(?:<\/style\s*>|$)/gi;

/** Cheap pre-check before rendering a message to look for styles. */
export const mayHaveStyle = (text: string) => /<style/i.test(text);

export function stripStyles(html: string): string {
	return html.replace(openStyleRe, '');
}

/** The CSS of every closed `<style>` element in rendered HTML. SVG rendering escapes `<` and `>` in element text, which a browser decodes inside an SVG style but CSS parsing does not. */
export function extractStyles(html: string): string {
	return Array.from(html.matchAll(styleElementRe), match => match[1]).join('\n').replace(/&gt;/g, '>').replace(/&lt;/g, '<');
}

export interface CssRule {
	/** Constructor name of the CSSOM rule, such as `CSSStyleRule` */
	kind: string;
	cssText: string;
}

/** Style rules and the conditional groups that can nest inside one. */
const nestable = new Set(['CSSStyleRule', 'CSSMediaRule', 'CSSSupportsRule', 'CSSContainerRule']);

export const MESSAGE_SCOPE = ':where(.messageList)';

/**
 * Nests rules under the message list, without adding specificity: `body` or `:root` selectors then match nothing.
 * Keyframes can't nest and their names are global, so they stay at the top level. Other at-rules (`@import`, `@font-face`) are dropped.
 */
export function scopeRules(rules: CssRule[]): string {
	const scoped = rules.filter(rule => nestable.has(rule.kind)).map(rule => rule.cssText);
	const keyframes = rules.filter(rule => rule.kind === 'CSSKeyframesRule').map(rule => rule.cssText);
	return [...keyframes, scoped.length ? `${MESSAGE_SCOPE} {\n${scoped.join('\n')}\n}` : ''].filter(Boolean).join('\n');
}

function parseRules(css: string): CssRule[] {
	const sheet = new CSSStyleSheet();
	sheet.replaceSync(css);
	return Array.from(sheet.cssRules, rule => ({ kind: rule.constructor.name, cssText: rule.cssText }));
}

/** Parsing first means unbalanced braces in model-written CSS can't close the scope early. */
export function scopeCss(css: string, parse = parseRules): string {
	return css.trim() ? scopeRules(parse(css)) : '';
}
