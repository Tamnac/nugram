import { isTauri } from './platform';
import { localBackend, type Backend } from './backend';

export interface Skill {
	name: string;
	description: string;
	path: string;
}

/** A discovered skill with the backend it was found on, which is where its file can be read. */
export interface SkillEntry extends Skill {
	backend: Backend;
}

export interface SkillDirs {
	/** Extra folders scanned relative to the chat folder (or absolute). */
	local: string[];
	/** Extra folders scanned relative to the home directory (or absolute). */
	global: string[];
}

export const DEFAULT_SKILL_DIRS: SkillDirs = { local: [], global: [] };

/** Skill folders the common agents read, relative to a project root. */
export const PROJECT_SKILL_DIRS = [
	'.skills',
	'.agents/skills',   // vendor-neutral: codex, cursor, zed, goose, copilot, crush, amp
	'.claude/skills',
	'.github/skills',   // copilot
	'.cursor/skills',
	'.codex/skills',
	'.opencode/skills',
	'.gemini/skills',
	'.windsurf/skills',
	'.cline/skills',
	'.roo/skills',
	'.pi/skills',
	'.kilo/skills',
	'.crush/skills',
	'.factory/skills',
	'.qwen/skills',
	'skills',
];

/** Skill folders the common agents read, relative to the user's home directory. */
export const HOME_SKILL_DIRS = [
	'skills',
	'.skills',
	'.agents/skills',
	'.claude/skills',
	'.config/agents/skills',
	'.copilot/skills',
	'.cursor/skills',
	'.codex/skills',
	'.config/opencode/skills',
	'.gemini/skills',
	'.codeium/windsurf/skills',
	'.cline/skills',
	'.roo/skills',
	'.pi/agent/skills',
	'.kilo/skills',
	'.config/crush/skills',
	'.config/amp/skills',
	'.factory/skills',
	'.qwen/skills',
];

export function joinPath(base: string, rel: string): string {
	const sep = base.includes('\\') ? '\\' : '/';
	return base.replace(/[/\\]$/, '') + sep + rel.replace(/[/\\]+/g, sep);
}

function isAbsolutePath(p: string): boolean {
	return /^([a-zA-Z]:[/\\]|[/\\])/.test(p);
}

/** Absolute, deduped roots to scan: the built-in list plus user-configured extras. */
export function skillRoots(base: string, defaults: string[], extra: string[] = []): string[] {
	if (!base) return [];
	const roots = [...defaults, ...extra]
		.map(d => d.trim())
		.filter(Boolean)
		.map(d => (isAbsolutePath(d) ? d.replace(/[/\\]$/, '') : joinPath(base, d)));
	return [...new Set(roots)];
}

function unquote(value: string): string {
	const q = value[0];
	if ((q === '"' || q === "'") && value.endsWith(q) && value.length > 1)
		return value.slice(1, -1).replace(/\\(['"\\])/g, '$1');
	return value;
}

/** Read `name`/`description` out of SKILL.md YAML frontmatter. Handles quoted values
 *  and `|`/`>` block scalars; nested maps (e.g. `metadata`) are skipped. */
export function parseSkillMeta(text: string): { name?: string; description?: string } {
	const match = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
	if (!match) return {};
	const lines = match[1].split(/\r?\n/);
	const fields: Record<string, string> = {};

	for (let i = 0; i < lines.length; i++) {
		const kv = lines[i].match(/^([A-Za-z][\w-]*):[ \t]*(.*)$/);
		if (!kv) continue;
		const [, key, raw] = kv;
		let value = raw.trim();
		if (/^[|>][-+]?\d*$/.test(value)) {
			const folded = value.startsWith('>');
			const block: string[] = [];
			while (i + 1 < lines.length && (!lines[i + 1].trim() || /^[ \t]/.test(lines[i + 1])))
				block.push(lines[++i].trim());
			value = (folded ? block.join(' ') : block.join('\n')).trim();
		} else {
			value = unquote(value);
		}
		fields[key] = value;
	}

	return { name: fields.name, description: fields.description };
}

type DirListing = Array<{ name: string; isDirectory: boolean }>;

async function readSkill(backend: Backend, dir: string, dirName: string, entries: DirListing): Promise<Skill | null> {
	// Match the entry case-insensitively so lowercase skill.md works on Linux too.
	// Use the on-disk casing in the returned path so read_file can open it.
	const file = entries.find(e => !e.isDirectory && e.name.toLowerCase() === 'skill.md');
	if (!file) return null;
	try {
		const path = joinPath(dir, file.name);
		const meta = parseSkillMeta(await backend.readText(path));
		return { name: meta.name?.trim() || dirName, description: meta.description ?? '', path };
	} catch {
		return null;
	}
}

/** Skills directly under `dir`; also looks one level deeper for grouped/bundled layouts.
 *  Each directory is listed exactly once and siblings are scanned concurrently: the scan
 *  is nothing but IPC round trips, so doing them one at a time dominated its cost. */
export async function skillsIn(backend: Backend, dir: string, depth = 1, listing?: DirListing): Promise<Skill[]> {
	let entries = listing;
	if (!entries) {
		try {
			entries = await backend.readDir(dir);
		} catch {
			return [];
		}
	}

	const nested = await Promise.all(entries
		.filter(entry => entry.isDirectory && !entry.name.startsWith('.'))
		.map(async entry => {
			const sub = joinPath(dir, entry.name);
			let subEntries: DirListing;
			try {
				subEntries = await backend.readDir(sub);
			} catch {
				return [];
			}
			const skill = await readSkill(backend, sub, entry.name, subEntries);
			if (skill) return [skill];
			return depth > 0 ? skillsIn(backend, sub, depth - 1, subEntries) : [];
		}));

	return nested.flat();
}

/** Scan roots for `<root>/<skill>/SKILL.md`. Earlier roots win on name collisions. */
export async function discoverSkills(roots: string[], backend: Backend = localBackend): Promise<Skill[]> {
	if (!isTauri || !roots.length) return [];
	const found = (await Promise.all(roots.map(root => skillsIn(backend, root)))).flat();
	const byName = new Map<string, Skill>();
	for (const skill of found) {
		const key = skill.name.toLowerCase();
		if (!byName.has(key)) byName.set(key, skill);
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function formatSkills(skills: Skill[], scope: 'project' | 'user'): string {
	if (!skills.length) return '';
	const list = skills
		.map(s => `- ${s.name}: ${s.description.replace(/\s+/g, ' ').trim()}\n  ${s.path}`)
		.join('\n');
	return `<skills scope="${scope}">\n${list}\n</skills>`;
}
