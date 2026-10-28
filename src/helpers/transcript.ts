import type { ChatMessage } from './types';
import { getMessageContent, getMessageToolCalls, getMessageToolResults } from './messages';
import { resolveContent } from './tools';
import { getMessageFiles } from './attachments';
import { fileBlock } from './fileContent';

// Markdown transcript of a chat, shared by the TopBar export menu and the auto-titler.
// `toolCalls` controls whether tool calls and file attachments are rendered ('preview'
// truncates argument/result values and reduces attachments to their header line, 'full'
// keeps them verbatim, undefined omits both).
export function formatToolCalls(msg: ChatMessage, format: 'preview' | 'full'): string {
	const calls = getMessageToolCalls(msg);
	if (!calls?.length) return '';
	const results = getMessageToolResults(msg);
	const limit = 40;

	function parseArgs(args: unknown): unknown {
		if (typeof args !== 'string') return args;
		try {
			return JSON.parse(args);
		} catch {
			return args;
		}
	}

	function truncate(text: string) {
		const compact = text.replace(/\s+/g, ' ').trim();
		return compact.length > limit ? compact.slice(0, limit).trimEnd() + '...' : compact;
	}

	function indent(text: string, level: number) {
		const pad = '  '.repeat(level);
		return text.split('\n').map(line => pad + line).join('\n');
	}

	function formatValue(value: unknown, level = 0): string {
		if (value === null || value === undefined) return '';
		if (typeof value === 'string') return format === 'preview' ? truncate(value) : value;
		if (typeof value === 'number' || typeof value === 'boolean') return String(value);
		if (Array.isArray(value)) {
			if (value.length === 0) return '[]';
			const pad = '  '.repeat(level);
			return value.map(item => {
				if (item && typeof item === 'object' && !Array.isArray(item)) {
					const lines = formatObject(item as Record<string, unknown>, level + 1).split('\n');
					return `${pad}- ${lines[0].trimStart()}${lines.length > 1 ? '\n' + lines.slice(1).join('\n') : ''}`;
				}
				return `${pad}- ${formatValue(item, level + 1)}`;
			}).join('\n');
		}
		if (typeof value === 'object') return formatObject(value as Record<string, unknown>, level);
		return String(value);
	}

	function formatObject(value: Record<string, unknown>, level = 0): string {
		return Object.entries(value).map(([key, val]) => {
			const formatted = formatValue(val, level + 1);
			if (!formatted.includes('\n')) return `${'  '.repeat(level)}${key}: ${formatted}`;
			return `${'  '.repeat(level)}${key}:\n${indent(formatted, level + 1)}`;
		}).join('\n');
	}

	return calls.map(call => {
		const name = call.function.name;
		const tagName = name.replace(/[^\w.-]/g, '_') || 'tool_call';
		const args = formatValue(parseArgs(call.function.arguments));
		const result = results?.find(r => r.tool_call_id === call.id);
		const resultText = result ? `\n\n---\n\nresult:\n${formatValue(resolveContent(result))}` : '';
		return `<${tagName}>\n${args}${resultText}\n</${tagName}>`;
	}).join('\n\n---\n\n');
}

export function messagesToMarkdown(messages: ChatMessage[], toolCalls?: 'preview' | 'full'): string {
	return messages.map(msg => {
		const toolCallsFormatted = toolCalls ? formatToolCalls(msg, toolCalls) : '';
		const files = toolCalls ? getMessageFiles(msg)?.map(file => fileBlock(file, toolCalls === 'preview')) ?? [] : [];
		const content = [...files, getMessageContent(msg)].filter(Boolean).join('\n\n');
		return `<${msg.role}>\n${content}${toolCallsFormatted ? `\n\n${toolCallsFormatted}` : ''}\n</${msg.role}>`;
	}).join('\n\n');
}
