import { Show } from 'solid-js';
import { searchLore, readLoreEntries, editLoreEntry, formatSearchResults, formatLoreEntries, type LoreReadResult } from '../lore';
import { thinkingParser, handleLinkClick } from '../markdown';
import { normalizeRange } from './shared';
import type { ToolModule } from './types';

export const grepLoreTool: ToolModule = {
	definition: {
		type: 'function',
		function: {
			name: 'grep_lore',
			description: ' Use this to find relevant lore before reading full content.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'Case-insensitive regex pattern (e.g. "dwarf|elf", "magic.*system"). Empty string returns all entries'
					},
					search_content: {
						type: 'boolean',
						description: '(Optional) Whether to also search entry content. false if not specified.'
					},
					limit: {
						type: 'integer',
						description: '(Optional) Max results to return. 20 if not specified.'
					}
				},
				required: ['query']
			}
		}
	},

	async execute(call, ctx) {
		if (!ctx.lore) return { ok: false, error: 'Lore system not available' };
		const args = call.function.arguments as any;
		const query = args?.query || '';
		return { query, results: searchLore(ctx.lore, query, args?.search_content || false, args?.limit || 20) };
	},

	format: data => formatSearchResults(data.results, data.query),

	Summary: props => <span>search <code>"{(props.call.function.arguments as any).query}"</code></span>,
};

export const readLoreEntriesTool: ToolModule = {
	definition: {
		type: 'function',
		function: {
			name: 'read_lore_entries',
			description: 'Read content of specified lore entries. Supports prefix matching - reading "Dwarves" will also return "Dwarves/culture", "Dwarves/history", etc. Case insensitive.',
			parameters: {
				type: 'object',
				properties: {
					entries: {
						type: 'array',
						description: 'Array of entries to read, each with a name and optional line range.',
						items: {
							type: 'object',
							properties: {
								name: {
									type: 'string',
									description: 'Lore entry name. Use prefix to get all entries under a category.'
								},
								range: {
									type: 'string',
									description: 'Optional line range as "start:end". Either side can be omitted for open-ended. Negative indices count from end. Examples: "5:15", "10:", ":20", "-5:", ":-3"'
								}
							},
							required: ['name']
						}
					}
				},
				required: ['entries']
			}
		}
	},

	async execute(call, ctx) {
		const args = call.function.arguments as any;
		// Normalize malformed range formats in entries and fix args for history
		if (Array.isArray(args?.entries)) {
			for (const entry of args.entries) {
				if (entry?.range) {
					const normalized = normalizeRange(entry.range);
					if (normalized) entry.range = normalized;
				}
			}
		}
		if (!ctx.lore) return { ok: false, error: 'No lore available' };
		return { entries: readLoreEntries(ctx.lore, args?.entries || []) };
	},

	format: data => formatLoreEntries(data.entries),

	Summary: props => {
		const args = props.call.function.arguments as any;
		return <span>read {(args.entries || []).map((e: any) => <>{' '}<code>{e.name}{e.range ? ' ' + e.range : ''}</code></>)}</span>;
	},

	Result: props => (
		<LoreEntries entries={(props.data.entries as LoreReadResult[] || []).map(e => ({
			name: e.name,
			desc: e.description,
			lines: e.sliced ? `${e.sliced.start}:${e.sliced.end} of ${e.sliced.total}` : undefined,
			content: e.content,
		}))} />
	),

	LegacyResult: props => {
		const entries = () => {
			const loreTagRegex = /<lore\s+name="([^"]+)"(?:\s+description="([^"]*)")?(?:\s+lines="([^"]*)")?>\n\n([\s\S]*?)\n\n<\/lore>/g;
			const out: LoreEntryView[] = [];
			let match;
			while ((match = loreTagRegex.exec(props.content)) !== null) {
				out.push({ name: match[1], desc: match[2], lines: match[3], content: match[4] });
			}
			return out;
		};
		return (
			<Show when={entries().length > 0} fallback={<div class='toolResultContent'>{props.content}</div>}>
				<LoreEntries entries={entries()} />
			</Show>
		);
	},
};

type LoreEntryView = { name: string; desc?: string | undefined; lines?: string | undefined; content: string };

function LoreEntries(props: { entries: LoreEntryView[] }) {
	return (
		<div class='toolResultLore'>
			{props.entries.map(e => (
				<div class='toolLoreEntry'>
					<div class='toolLoreHeader'>
						<span class='toolEntryBadge'>{e.name}</span>
						{e.lines ? <span class='toolEntryRange'>{' ' + e.lines}</span> : null}
						{e.desc ? <span style={{ opacity: '0.5' }}>{' \u2014 ' + e.desc}</span> : null}
					</div>
					<div class='toolLoreContent' innerHTML={thinkingParser.render(e.content)} onClick={handleLinkClick} />
				</div>
			))}
		</div>
	);
}

export const editLoreEntryTool: ToolModule = {
	definition: {
		type: 'function',
		function: {
			name: 'edit_lore_entry',
			description: 'Create or update a lore entry',
			parameters: {
				type: 'object',
				properties: {
					name: {
						type: 'string',
						description: 'Name of the lore entry. Use "/" for hierarchy with max one level (e.g., "Dwarves/culture")'
					},
					content: {
						type: 'string',
						description: 'The content to append (or full content if mode is "rewrite")'
					},
					mode: {
						type: 'string',
						enum: ['append', 'rewrite'],
						description: 'Optional. "append" (default) appends to end. "rewrite" replaces full content. Identical for new entries.'
					},
					description: {
						type: 'string',
						description: 'Optional short description for context when searching'
					}
				},
				required: ['name', 'content']
			}
		}
	},

	async execute(call, ctx) {
		if (!ctx.lore || !ctx.setLore) return { ok: false, error: 'Lore system not available' };
		const args = call.function.arguments as any;
		const entryName = args?.name;
		const content: string = args?.content;
		const description = args?.description;
		const mode: 'append' | 'rewrite' = args?.mode === 'rewrite' ? 'rewrite' : 'append';

		if (!entryName || content === undefined)
			return { ok: false, error: 'Error: name and content are required' };

		const isNew = !ctx.lore.find(e => e.name === entryName);
		ctx.setLore(editLoreEntry(ctx.lore, entryName, content, description, mode));

		return { name: entryName, mode, isNew, lines: content.split('\n').length };
	},

	format: data => {
		// number of lines added or changed for feedback
		const modified = `${data.lines} lines` + (data.mode === 'append' ? ` appended` : ` rewritten`);
		const verb = data.mode === 'append' ? 'Appended to' : 'Rewrote';
		return data.isNew
			? `Created lore entry "${data.name}":\n${modified}`
			: `${verb} lore entry "${data.name}":\n${modified}\n\n(Previous content saved, user may revert)`;
	},

	Summary: props => {
		const args = props.call.function.arguments as any;
		return <span>{args.mode === 'rewrite' ? 'rewrite' : 'append to'} <code>{args.name}</code></span>;
	},

	Args: props => {
		const args = props.call.function.arguments as any;
		return (
			<div class='toolArgEdit'>
				<span class='toolEntryBadge'>{args.name}</span>
				<span style={{ opacity: '0.6' }}>{' ' + (args.mode ?? 'append')}</span>
				{args.description ? <span style={{ opacity: '0.5' }}>{' \u2014 ' + args.description}</span> : null}
				{args.content ? <div class='toolArgContent' innerHTML={thinkingParser.render(args.content)} onClick={handleLinkClick} /> : null}
			</div>
		);
	},
};
