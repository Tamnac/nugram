import type { Setter } from 'solid-js';

export interface LoreEntry {
  name: string;
  description: string;
  content: string;
  previousContent?: string | undefined;
}

const LORE_STORAGE_KEY = 'lore_entries';

export function loadLore(onError?: Setter<string | null>): LoreEntry[] {
  try {
    const stored = localStorage.getItem(LORE_STORAGE_KEY);
    if (!stored) return [];
    return JSON.parse(stored) as LoreEntry[];
  } catch (error) {
    const msg = 'Failed to load lore from localStorage: ' + (error instanceof Error ? error.message : String(error));
    console.error(msg, error);
    onError?.(msg);
    return [];
  }
}

export function exportLore(entries: LoreEntry[]): string {
  return JSON.stringify(entries, null, 2);
}

export function importLore(json: string): LoreEntry[] {
  return JSON.parse(json) as LoreEntry[];
}

// Search lore entries with priority weighting: name > description > (optionally content)
export function searchLore(entries: LoreEntry[], query: string, searchContent: boolean = false, limit: number = 20): { name: string; description: string }[] {
  if (!query.trim()) return entries.map(e => ({ name: e.name, description: e.description }));

  let regex: RegExp;
  try {
    regex = new RegExp(query, 'i');
  } catch {
    regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }

  return entries
    .filter(e => regex.test(e.name) || regex.test(e.description) || (searchContent && regex.test(e.content)))
    .sort((a, b) => {
      const score = (e: LoreEntry) => (regex.test(e.name) ? 3 : 0) + (regex.test(e.description) ? 2 : 0) + (searchContent && regex.test(e.content) ? 1 : 0);
      return score(b) - score(a);
    })
    .slice(0, limit)
    .map(e => ({ name: e.name, description: e.description }));
}

export interface LoreReadRequest {
	name: string;
	range?: string; // "start:end" line range, supports negative indices, open-ended
}

function parseRange(range: string, totalLines: number): [number, number] | null {
	const colon = range.indexOf(':');
	if (colon === -1) return null;

	const startStr = range.slice(0, colon).trim();
	const endStr = range.slice(colon + 1).trim();

	let start = startStr ? parseInt(startStr, 10) : 0;
	let end = endStr ? parseInt(endStr, 10) : totalLines;
	if (isNaN(start) || isNaN(end)) return null;

	if (start < 0) start = Math.max(0, totalLines + start);
	if (end < 0) end = Math.max(0, totalLines + end);

	start = Math.min(start, totalLines);
	end = Math.min(end, totalLines);
	if (start > end) return null;

	return [start, end];
}

function applyRange(content: string, range?: string): { content: string; sliced?: { start: number; end: number; total: number } } {
	if (!range) return { content };
	const lines = content.split('\n');
	const parsed = parseRange(range, lines.length);
	if (!parsed) return { content };
	const [start, end] = parsed;
	return { content: lines.slice(start, end).join('\n'), sliced: { start, end, total: lines.length } };
}

export interface LoreReadResult extends LoreEntry {
	sliced?: { start: number; end: number; total: number };
}

// Read lore entries by name with prefix matching (case-insensitive)
// Reading "Dwarves" returns "Dwarves" + all "Dwarves/*" entries
// Reading "Culture" also returns "Dwarves/culture" (child match)
// Each request can include a line range ("start:end", open-ended, negative indices)
export function readLoreEntries(entries: LoreEntry[], requests: LoreReadRequest[]): LoreReadResult[] {
	const results: LoreReadResult[] = [];
	const seenNames = new Set<string>();

	for (const req of requests) {
		const nameLower = req.name.toLowerCase();
		for (const entry of entries) {
			if (seenNames.has(entry.name)) continue;

			const entryNameLower = entry.name.toLowerCase();
			let matched = false;
			// Exact match or prefix match (e.g., "Dwarves" matches "Dwarves/culture")
			if (entryNameLower === nameLower || entryNameLower.startsWith(nameLower + '/')) {
				matched = true;
			}
			// Suffix match: if name has no slash, match "*/name" (e.g., "Culture" matches "Dwarves/culture")
			else if (!nameLower.includes('/') && entryNameLower.endsWith('/' + nameLower)) {
				matched = true;
			}

			if (matched) {
				const { content, sliced } = applyRange(entry.content, req.range);
				results.push({ ...entry, content, ...(sliced && { sliced }) });
				seenNames.add(entry.name);
			}
		}
	}

	return results;
}

export function editLoreEntry(
  entries: LoreEntry[],
  name: string,
  content: string,
  description?: string,
  mode: 'append' | 'rewrite' = 'append'
): LoreEntry[] {
  const existingIndex = entries.findIndex(e => e.name === name);

  if (existingIndex >= 0) {
    // Update existing entry, stash current content to previousContent
    const updated = [...entries];
    const existing = updated[existingIndex];
    const newContent = mode === 'append'
      ? (existing.content.endsWith('\n') ? existing.content + content : existing.content + '\n' + content)
      : content;
    updated[existingIndex] = {
      ...existing,
      content: newContent,
      previousContent: existing.content,
      ...(description !== undefined && { description })
    };
    return updated;
  } else {
    return [...entries, {
      name,
      description: description || '',
      content,
      previousContent: undefined
    }];
  }
}

export function revertLoreEntry(entries: LoreEntry[], name: string): LoreEntry[] {
  const existingIndex = entries.findIndex(e => e.name === name);
  if (existingIndex < 0) return entries;

  const entry = entries[existingIndex];
  if (!entry.previousContent) return entries;

  const updated = [...entries];
  updated[existingIndex] = {
    ...entry,
    content: entry.previousContent,
    previousContent: entry.content // Swap so user can toggle back
  };
  return updated;
}

export function deleteLoreEntry(entries: LoreEntry[], name: string): LoreEntry[] {
  return entries.filter(e => e.name !== name);
}

export function formatSearchResults(results: { name: string; description: string }[], query?: string): string {
  let formatted = "Matched entries"

  if (query) formatted += ` for /${query}/`
  formatted += `:\n`

  if (results.length === 0) return formatted + 'No entries found.';
  
  formatted += results.map(r => 
    r.description ? `- \`${r.name}\` description: ${r.description}` : `- \`${r.name}\``
  ).join('\n');

  formatted += '\n\n(Use read_lore_entries for full content.)';
  return formatted;
}

export function formatLoreEntries(entries: LoreReadResult[]): string {
	if (entries.length === 0) return 'No lore entries found.';

	return entries.map(e => {
		const desc = e.description ? ` description="${e.description}"` : '';
		const range = e.sliced ? ` lines="${e.sliced.start}:${e.sliced.end} of ${e.sliced.total}"` : '';
		return `<lore name="${e.name}"${desc}${range}>\n\n${e.content}\n\n</lore>`;
	}).join('\n\n\n');
}
