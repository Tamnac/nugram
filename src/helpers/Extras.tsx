import { Setter } from "solid-js";
import type { ChatMessage } from './types';
import { getMessageContent } from './messages';
import { LoreEntry, readLoreEntries } from "./lore";
import { playSound } from './sounds';
export { playSound } from './sounds';

export function loadFromStorage<T>(key: string, defaultValue: T, parseJson: boolean = true, onError?: Setter<string | null>): T {
  try {
    const stored = localStorage.getItem(key);
    if (!stored) return defaultValue;
    
    if (parseJson) {
      const result = JSON.parse(stored) as T;
      // Treat parsed falsy values (null, undefined, "") as missing — but preserve
      // legitimate falsy primitives like false and 0.
      if (!result && result !== false && result !== 0) return defaultValue;
      return result;
    }
    else           return stored as unknown as T;
    
  } catch (error) {
    const msg = `Failed to parse ${key} from localStorage: ` + (error instanceof Error ? error.message : String(error));
    console.error(msg, error);
    onError?.(msg);
    if (error instanceof SyntaxError) {
      localStorage.removeItem(key);
    }
    return defaultValue;
  }
}

export function d_txt(content: string, filename: string, type = 'text/plain') {
	const blob = new Blob([content], { type });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL(url);
}

// Timer Component
export function TimerDisplay(props: {
	remaining: number;
	isReady?: boolean;
	duration?: number;
	onStart?: () => void;
}) {
	const formatTime = (seconds: number) => {
		const minutes = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${minutes}:${secs.toString().padStart(2, '0')}`;
	};

	const handleClick = () => {
		if (props.isReady && props.onStart) {
			props.onStart();
		}
	};

	const getDisplayText = () => {
		if (props.remaining <= 0) return 'TIME!';
		if (props.isReady) return `▶ ${formatTime(props.duration || props.remaining)}`;
		return formatTime(props.remaining);
	};

	const getBackgroundColor = () => {
		if (props.remaining <= 0) return 'rgba(255, 0, 0, 0.9)';
		if (props.isReady) return 'rgba(0, 100, 0, 0.8)';
		return 'rgba(0, 0, 0, 0.8)';
	};

	return (
		<div
			onClick={handleClick}
			style={{
				position: 'fixed',
				top: '20px',
				right: '20px',
				background: getBackgroundColor(),
				color: 'white',
				padding: '10px 20px',
				'border-radius': '8px',
				'font-size': '24px',
				'font-weight': 'bold',
				'z-index': '2',
				'font-family': 'monospace',
				cursor: props.isReady ? 'pointer' : 'default',
				'user-select': 'none'
			}}>
			{getDisplayText()}
		</div>
	);
}

// Timer functionality
export function startTimer(seconds: number, setTimerActive: (active: boolean) => void, setTimerRemaining: (remaining: number) => void, setTimerReady?: (ready: boolean) => void) {
	if (setTimerReady) setTimerReady(false); // Timer is no longer ready, it's running
	setTimerActive(true);
	setTimerRemaining(seconds);

	setTimeout(() => {
		playSound('timer');

		let remaining = seconds;
		const interval = setInterval(() => {
			remaining--;
			setTimerRemaining(remaining);

			if (remaining <= 0) {
				clearInterval(interval);
				playSound('timer');

				// Hide timer after 3 seconds
				setTimeout(() => {
					setTimerActive(false);
				}, 3000);
			}
		}, 1000);
	}, 3000); // 3-second delay
}



export function reLore(content: string, messages: ChatMessage[], lore: LoreEntry[]) {
	// Match @name, @[name with spaces], @ref[name with spaces], @ref 123 (for message refs)
	const entries = content.match(/@(?:ref\s*)?(?:\[[^\]]*\]|[\w+\/\-]+)/g)?.map(m => m.slice(1));
	let toShow = false;

	const results = [...new Set(entries)]?.map(entry => {
		// Handle @ref <number> for message references
	if (/^ref\s*\d+$/i.test(entry) && messages[Number(entry.match(/\d+/)![0])]) {
			toShow = true;
			const msgContent = getMessageContent(messages[Number(entry.match(/\d+/)![0])])
				.split('\n')
				.map(line => `> ${line}`)
				.join('\n');

			return `The user has referenced past message ${entry}. This is for reference, it is not from the current scene.\n\n${msgContent}`;
		}

		// Strip brackets and optional 'ref' prefix for lookup
		const cleanEntry = entry.replace(/^ref\s*/, '').replace(/^\[|\]$/g, '');

		// Find lore entry by name (exact match or prefix match)
		const matchedEntries = readLoreEntries(lore, [{ name: cleanEntry }]);
		if (matchedEntries.length > 0) {
			return matchedEntries.map(e => 
				`<lore name="${e.name}"${e.description ? ` description="${e.description}"` : ''}>\n${e.content}\n</lore>`
			).join('\n\n');
		}

		return null;
	}).filter(Boolean);

	if (toShow && entries?.length && !results?.length)
		return `<lore>\nNo lore entries found for: ${entries.join(', ')}\n</lore>`;
	if (!results?.length) return null;

	const message = results.length === 1 ? results[0] : results.join('\n\n---\n\n');
	return `(auto tool response, not an actual user message)\n\n${message}`;
}

export function msgVars(content: string, macros?: Record<string, string>, model?: string, chatFolder?: string, chatId?: string): string {
	let result = content
		.replace(/@@time/ig, new Date().toLocaleTimeString())
		.replace(/@@date/ig, new Date().toLocaleDateString())
		.replace(/@@model/ig, model || '')
		.replace(/@@folder/ig, chatFolder || '')
		.replace(/@@id/ig, chatId || '');
	if (macros) {
		for (const [k, v] of Object.entries(macros)) {
			if (!k) continue;
			const re = new RegExp(`@@${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'gi');
			result = result.replace(re, v);
		}
	}
	return result;
}
