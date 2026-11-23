import { Show, createMemo, createEffect } from 'solid-js';
import type { ChatMessage } from './helpers/types';
import { searchLoadedMessages, type LoadedMatch } from './helpers/search';
import { TbOutlineChevronUp, TbOutlineChevronDown, TbOutlineX, TbOutlineSearch } from 'solid-icons/tb';

/**
 * In-chat search (Ctrl+Shift+F). Replaces the top bar's contents while open.
 *
 * Scans the loaded messages array directly: instant even at 20K messages, and
 * it searches exactly what's on screen (current versions). Navigation goes
 * through `scrollToMessage`, the only function windowed loading would need to
 * replace.
 */
export function SearchBar(props: {
	messages: ChatMessage[];
	query: string;
	setQuery: (q: string) => void;
	/** Index into the results array (not into messages); -1 before the first jump. */
	active: number;
	setActive: (i: number) => void;
	allVersions: boolean;
	setAllVersions: (v: boolean) => void;
	onJump: (idx: number) => void;
	onClose: () => void;
}) {
	const results = createMemo<LoadedMatch[]>(() =>
		searchLoadedMessages(props.messages, props.query, props.allVersions)
	);

	// Clamp the selected index when the number of results drops.
	createEffect(() => {
		if (props.active >= results().length) props.setActive(results().length - 1);
	});

	function step(delta: number) {
		const len = results().length;
		if (len === 0) return;
		// With no match selected, Enter selects the first match and Shift+Enter the
		// last, instead of moving one past them.
		const next = props.active < 0
			? (delta > 0 ? 0 : len - 1)
			: (props.active + delta + len) % len;
		props.setActive(next);
		props.onJump(results()[next].idx);
	}

	function onKeyDown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			step(e.shiftKey ? -1 : 1);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			props.onClose();
		}
	}

	return (
		<div class='searchBar'>
			{/* Shares a view-transition-name with the top bar's search button, so
			    opening the bar animates the icon from the button to the bar. */}
			<span class='searchIcon searchMorph'><TbOutlineSearch size={18} /></span>
			<input
				class='searchInput'
				type='text'
				placeholder='Search this chat...'
				value={props.query}
				onInput={e => { props.setQuery(e.currentTarget.value); props.setActive(-1); }}
				onKeyDown={onKeyDown}
				ref={el => setTimeout(() => { el.focus(); el.select(); }, 0)}
			/>
			<span class='searchCount'>
				<Show when={props.query} fallback='—'>
					<Show when={results().length} fallback='no results'>
						<Show when={props.active >= 0} fallback={`${results().length} match${results().length > 1 ? 'es' : ''}`}>
							{props.active + 1} / {results().length}
						</Show>
					</Show>
				</Show>
			</span>
			<button class='slim-but' title='Previous match (Shift+Enter)' disabled={!results().length} onClick={() => step(-1)}>
				<TbOutlineChevronUp size={16} />
			</button>
			<button class='slim-but' title='Next match (Enter)' disabled={!results().length} onClick={() => step(1)}>
				<TbOutlineChevronDown size={16} />
			</button>
			<label class='searchScope' title="Also search messages' other versions. Jumping to a match doesn't change which version is shown.">
				<input
					type='checkbox'
					checked={props.allVersions}
					onInput={e => { props.setAllVersions(e.currentTarget.checked); props.setActive(-1); }}
				/>
				<span>all versions</span>
			</label>
			<button class='slim-but' title='Close (Esc)' onClick={props.onClose}>
				<TbOutlineX size={16} />
			</button>
		</div>
	);
}
