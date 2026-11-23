/**
 * Chat back/forward history persistence.
 *
 * The browser's history is lost when the window closes, so a parallel stack of
 * chat ids is kept in localStorage and rebuilt on launch.
 * All windows read the stack on launch, but only one window (the owner) writes it. A window
 * that starts while another owner is active keeps its history in memory only, so it can't
 * overwrite the history of the window the user is navigating in.
 */

const STACK_KEY = 'chat_nav_history';
const OWNER_KEY = 'chat_nav_owner';
const MAX_ENTRIES = 50;
const HEARTBEAT_MS = 5000;
const OWNER_STALE_MS = 15000;

type NavStack = { stack: string[]; idx: number };

const windowId = Math.random().toString(36).slice(2);
let nav: NavStack = { stack: [], idx: -1 };
let owner = false;

function persist() {
	if (!owner) return;
	try {
		localStorage.setItem(STACK_KEY, JSON.stringify(nav));
	} catch { /* history is a convenience, never fail a navigation over it */ }
}

function readStack(): NavStack | null {
	try {
		const raw = localStorage.getItem(STACK_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed?.stack) || typeof parsed?.idx !== 'number') return null;
		const stack = parsed.stack.filter((id: unknown) => typeof id === 'string');
		if (!stack.length) return null;
		return { stack, idx: Math.min(Math.max(parsed.idx, 0), stack.length - 1) };
	} catch {
		return null;
	}
}

/** Claims the shared stack unless another window refreshed the owner heartbeat within OWNER_STALE_MS. */
function claimOwnership(): boolean {
	try {
		const raw = localStorage.getItem(OWNER_KEY);
		const held = raw ? JSON.parse(raw) : null;
		if (held && held.id !== windowId && Date.now() - (held.ts ?? 0) < OWNER_STALE_MS) return false;

		const beat = () => localStorage.setItem(OWNER_KEY, JSON.stringify({ id: windowId, ts: Date.now() }));
		beat();
		setInterval(beat, HEARTBEAT_MS);
		window.addEventListener('pagehide', () => {
			const current = localStorage.getItem(OWNER_KEY);
			if (current && JSON.parse(current)?.id === windowId) localStorage.removeItem(OWNER_KEY);
		});
		return true;
	} catch {
		return false;
	}
}

export function pushNav(id: string, url: string) {
	if (nav.idx < 0) return replaceNav(id, url);
	nav.stack = nav.stack.slice(0, nav.idx + 1);
	nav.stack.push(id);
	if (nav.stack.length > MAX_ENTRIES) nav.stack = nav.stack.slice(-MAX_ENTRIES);
	nav.idx = nav.stack.length - 1;
	history.pushState({ chatId: id, navIdx: nav.idx }, '', url);
	persist();
}

/** Removes a deleted chat from the stack so back/forward skips it. */
export function removeNav(id: string) {
	const i = nav.stack.indexOf(id);
	if (i < 0) return;
	nav.stack.splice(i, 1);
	if (i <= nav.idx) nav.idx--;
	persist();
}

export function replaceNav(id: string, url: string) {
	if (nav.idx < 0) nav = { stack: [id], idx: 0 };
	else nav.stack[nav.idx] = id;
	history.replaceState({ chatId: id, navIdx: nav.idx }, '', url);
	persist();
}

/** Updates the saved position after a back/forward navigation to match the webview's history. */
export function syncNav(state: any) {
	const idx = typeof state?.navIdx === 'number' ? state.navIdx : nav.stack.indexOf(state?.chatId);
	if (idx < 0 || idx >= nav.stack.length) return;
	nav.idx = idx;
	persist();
}

/**
 * Rebuild browser history entries from the saved stack. With a `currentId`, the browser ends on the
 * saved position, which must be that chat. With `null` (a launch that opens a new chat), the browser
 * stays at the end, so the next push follows the saved entries.
 */
export function restoreNav(
	currentId: string | null,
	existingIds: Set<string>,
	urlFor: (id: string) => string,
) {
	owner = claimOwnership();
	const saved = readStack();
	const { stack, idx } = saved ? survivingEntries(saved, existingIds) : { stack: [], idx: 0 };
	if (currentId === null) {
		if (stack.length) rebuild(stack, stack.length - 1, urlFor);
		return;
	}
	if (stack[idx] !== currentId) return replaceNav(currentId, urlFor(currentId));

	rebuild(stack, idx, urlFor);
	if (idx < stack.length - 1) history.go(idx - (stack.length - 1));
}

/** Saved entries that still exist. The position stays on the entry that was current, or the closest earlier one still present. */
function survivingEntries(saved: NavStack, existingIds: Set<string>) {
	const stack: string[] = [];
	let idx = 0;
	saved.stack.forEach((id, i) => {
		if (!existingIds.has(id)) return;
		if (i <= saved.idx) idx = stack.length;
		stack.push(id);
	});
	return { stack, idx };
}

function rebuild(stack: string[], idx: number, urlFor: (id: string) => string) {
	history.replaceState({ chatId: stack[0], navIdx: 0 }, '', urlFor(stack[0]!));
	for (let i = 1; i < stack.length; i++)
		history.pushState({ chatId: stack[i], navIdx: i }, '', urlFor(stack[i]!));
	nav = { stack, idx };
	persist();
}
