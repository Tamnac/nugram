import { Remarkable } from 'remarkable';
import { isTauri, openExternal } from './platform';

/** Markdown parser for thinking traces and tool content (no raw HTML). */
export const thinkingParser = new Remarkable({ html: false, typographer: false });
thinkingParser.block.ruler.disable(['code']);

/** Chat folder for resolving relative paths in links, set by MessageList. */
let linkCwd: (() => string | undefined) | undefined;
export function setLinkCwd(fn: () => string | undefined) { linkCwd = fn; }

export async function handleLinkClick(e: MouseEvent) {
	const anchor = (e.target as HTMLElement).closest('a');
	if (!anchor) return;
	const href = anchor.getAttribute('href');
	if (!href) return;
	// Hash-only links navigate within the page, leave them alone
	if (href.startsWith('#')) return;
	const isWebUrl = href.startsWith('http://') || href.startsWith('https://');
	// On web, let web URLs behave normally. In Tauri we never let a link
	// take over the webview: web URLs go to the system browser, file paths
	// open with their default app.
	if (isWebUrl && !isTauri) return;
	e.preventDefault();
	if (isTauri) {
		await openExternal(href, linkCwd?.()).catch(console.error);
	}
}
