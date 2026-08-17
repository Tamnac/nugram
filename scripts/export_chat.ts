#!/usr/bin/env bun
// @ts-nocheck
/**
 * export_chat.ts — CLI tool to convert exported chat JSON files to other formats.
 *
 * Usage:
 *   bun export_chat.ts <input.json> [options]
 *
 * Options:
 *   --format <json|md>    Output format (default: md)
 *   --range <full|cut>    full = all messages, cut = from cutoff marker onward (default: full)
 *   --out <path>          Output file path (default: stdout)
 *   --cut-index <n>       Explicit 0-based cutoff index (overrides auto-detect)
 *
 * The cutoff point is auto-detected by looking for a message with `cutoff: true`,
 * matching the in-app behaviour where a cut marker separates background from active context.
 *
 * Examples:
 *   bun export_chat.ts conv_json.json
 *   bun export_chat.ts conv_json.json --format md --range cut --out out.md
 *   bun export_chat.ts conv_json.json --format json --range cut --out trimmed.json
 */

import { readFileSync, writeFileSync } from 'fs';
import { parseArgs } from 'util';

// ── Types (mirrors App.tsx) ───────────────────────────────────────────────────

interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | string[];
  thinking?: string | string[];
  currentVersionIndex?: number;
  cutoff?: boolean;
  [key: string]: unknown;
}

// NOTE: this mirrors the exportMessages() function in src/TopBar.tsx. Keep in sync when changing formats or slice behaviour.
// ── Helpers ───────────────────────────────────────────────────────────────────

function getMessageContent(msg: ChatMessage): string {
  const index = msg.currentVersionIndex ?? 0;
  if (Array.isArray(msg.content)) {
    return msg.content[index] ?? msg.content[0] ?? '';
  }
  return msg.content ?? '';
}

function findCutIndex(messages: ChatMessage[]): number {
  // Look for explicit cutoff marker first
  const idx = messages.findLastIndex(m => (m as any).cutoff === true);
  return idx;
}

function toMarkdown(messages: ChatMessage[]): string {
  return messages
    .map(msg => `<${msg.role}>\n${getMessageContent(msg)}\n</${msg.role}>`)
    .join('\n\n');
}

function omitRuntimeMessageFields(key: string, value: unknown) {
  return key === '_dbId' ? undefined : value;
}

function toJson(messages: ChatMessage[]): string {
  return JSON.stringify(messages, omitRuntimeMessageFields, 2);
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    format:    { type: 'string', default: 'md' },
    range:     { type: 'string', default: 'full' },
    out:       { type: 'string' },
    'cut-index': { type: 'string' },
    help:      { type: 'boolean', short: 'h', default: false },
  },
  allowPositionals: true,
});

if (values.help || positionals.length === 0) {
  console.log(`Usage: bun export_chat.ts <input.json> [--format md|json] [--range full|cut] [--out path] [--cut-index n]`);
  process.exit(positionals.length === 0 ? 1 : 0);
}

const inputPath = positionals[0];
const format = (values.format as string).toLowerCase();
const range  = (values.range  as string).toLowerCase();

if (!['md', 'json'].includes(format)) {
  console.error(`Unknown format "${format}". Use md or json.`);
  process.exit(1);
}
if (!['full', 'cut'].includes(range)) {
  console.error(`Unknown range "${range}". Use full or cut.`);
  process.exit(1);
}

// Load input
let messages: ChatMessage[];
try {
  const raw = readFileSync(inputPath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (Array.isArray(parsed)) {
    messages = parsed as ChatMessage[];
  } else if (parsed.messages && Array.isArray(parsed.messages)) {
    messages = parsed.messages as ChatMessage[];
  } else {
    throw new Error('Expected a JSON array of messages or a chat envelope');
  }
} catch (err) {
  console.error(`Failed to read "${inputPath}": ${(err as Error).message}`);
  process.exit(1);
}

// Determine slice
let sliced = messages;
if (range === 'cut') {
  const cutIndex = values['cut-index'] !== undefined
    ? parseInt(values['cut-index'] as string, 10)
    : findCutIndex(messages);

  if (cutIndex < 0) {
    console.warn('No cutoff marker found; exporting all messages.');
  } else {
    // Matches app behaviour: slice(cutIndex + 1) — first message after the cut
    sliced = messages.slice(cutIndex + 1);
    console.error(`Cut at index ${cutIndex}, exporting ${sliced.length} messages.`);
  }
}

// Render
const output = format === 'json' ? toJson(sliced) : toMarkdown(sliced);

// Write
if (values.out) {
  writeFileSync(values.out as string, output, 'utf-8');
  console.error(`Written to ${values.out}`);
} else {
  process.stdout.write(output + '\n');
}
