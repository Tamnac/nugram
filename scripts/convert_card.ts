// Convert a SillyTavern character card (.png with embedded data, or .json) into files for the app:
//   <name>.config.json  the character as prompts: sidebar → Config → Import
//   <name>.chat.json    the greeting (alternates as versions) and the char/user macros: top bar upload button. Import the config first.
//   <name>.lore.json    the card's embedded lorebook, only if it has one: sidebar → Lore → Import (replaces the current lore)
// Usage: bun scripts/convert_card.ts <card.png|card.json> [output_folder] [--user "Your name"]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { cardFromPng, convertSTCard, parseSTCard } from '../src/helpers/stImport';

const args = process.argv.slice(2);
const userFlag = args.indexOf('--user');
const userName = userFlag >= 0 ? args.splice(userFlag, 2)[1] : undefined;
const [input, outDir = '.'] = args;
if (!input) {
	console.error('Usage: bun convert_card.ts <card.png|card.json> [output_folder] [--user "Your name"]');
	process.exit(1);
}

const bytes = readFileSync(input);
const raw = /\.png$/i.test(input) ? cardFromPng(bytes) : JSON.parse(bytes.toString('utf8'));
const { config, chat, lore } = convertSTCard(parseSTCard(raw), userName);

const base = config.name.replace(/[<>:"/\|?*]/g, '_');
mkdirSync(outDir, { recursive: true });
const write = (suffix: string, data: unknown) => {
	const file = join(outDir, `${base}.${suffix}.json`);
	writeFileSync(file, JSON.stringify(data, null, 2));
	console.log(`Wrote ${file}`);
};
write('config', config);
write('chat', chat);
if (lore.length) write('lore', lore);
