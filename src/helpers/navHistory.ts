/**
 * Chat back/forward history persistence.
 *
 * The browser's own history dies with the window. Keep a parallel stack of
 * chat ids in localStorage and rebuild on launch.
 * Shared across windows but owned by one. A window
 * that finds a live owner runs ephemerally and never writes, so it can't clobber
 * the history of the window the user is actually navigating in.
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

/** Claim the shared stack unless another window is alive and holding it. */
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
	nav.stack = nav.stack.slice(0, nav.idx + 1);
	nav.stack.push(id);
	if (nav.stack.length > MAX_ENTRIES) nav.stack = nav.stack.slice(-MAX_ENTRIES);
	nav.idx = nav.stack.length - 1;
	history.pushState({ chatId: id, navIdx: nav.idx }, '', url);
	persist();
}

export function replaceNav(id: string, url: string) {
	if (nav.idx < 0) nav = { stack: [id], idx: 0 };
	else nav.stack[nav.idx] = id;
	history.replaceState({ chatId: id, navIdx: nav.idx }, '', url);
	persist();
}

/** Follow a back/forward step so the persisted position matches the webview's. */
export function syncNav(state: any) {
	const idx = typeof state?.navIdx === 'number' ? state.navIdx : nav.stack.indexOf(state?.chatId);
	if (idx < 0 || idx >= nav.stack.length) return;
	nav.idx = idx;
	persist();
}

/** Rebuild browser history entries from the saved stack, unless pinned */
export function restoreNav(
	currentId: string,
	exists: (id: string) => boolean,
	urlFor: (id: string) => string,
	pinned: boolean,
) {
	owner = claimOwnership();
	const saved = owner && !pinned ? readStack() : null;
	if (!saved) return replaceNav(currentId, urlFor(currentId));

	// Deleted chats drop out; the position stays on its own entry.
	const stack: string[] = [];
	let idx = 0;
	saved.stack.forEach((id, i) => {
		if (!exists(id)) return;
		if (i <= saved.idx) idx = stack.length;
		stack.push(id);
	});
	if (stack[idx] !== currentId) return replaceNav(currentId, urlFor(currentId));

	history.replaceState({ chatId: stack[0], navIdx: 0 }, '', urlFor(stack[0]!));
	for (let i = 1; i < stack.length; i++)
		history.pushState({ chatId: stack[i], navIdx: i }, '', urlFor(stack[i]!));
	nav = { stack, idx };
	persist();
	if (idx < stack.length - 1) history.go(idx - (stack.length - 1));
}
