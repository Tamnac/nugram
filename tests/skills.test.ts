import { describe, expect, test } from 'bun:test';
import { formatSkills, joinPath, parseSkillMeta, skillRoots, skillsIn, type Skill } from '../src/helpers/skills';
import type { Backend } from '../src/helpers/backend';

describe('parseSkillMeta', () => {
	test('reads plain and quoted values', () => {
		expect(parseSkillMeta('---\nname: pdf-processing\ndescription: "Extract PDF text. Use for PDFs."\n---\n# body'))
			.toEqual({ name: 'pdf-processing', description: 'Extract PDF text. Use for PDFs.' });
	});

	test('reads block scalars', () => {
		const folded = parseSkillMeta('---\nname: a\ndescription: >-\n  first line\n  second line\n---\n');
		expect(folded.description).toBe('first line second line');
		const literal = parseSkillMeta('---\nname: a\ndescription: |\n  first line\n  second line\n---\n');
		expect(literal.description).toBe('first line\nsecond line');
	});

	test('ignores nested maps and trailing keys', () => {
		const meta = parseSkillMeta('---\nmetadata:\n  name: wrong\n  version: "1.0"\nname: right\n---\n');
		expect(meta.name).toBe('right');
	});

	test('handles CRLF and a BOM', () => {
		expect(parseSkillMeta('\uFEFF---\r\nname: a\r\ndescription: b\r\n---\r\n'))
			.toEqual({ name: 'a', description: 'b' });
	});

	test('no frontmatter yields nothing', () => {
		expect(parseSkillMeta('# just markdown\nname: nope')).toEqual({});
	});
});

describe('skillRoots', () => {
	test('joins relatives, keeps absolutes, dedupes', () => {
		expect(skillRoots('/home/u', ['.claude/skills', '.agents/skills'], ['.claude/skills', '/opt/skills']))
			.toEqual(['/home/u/.claude/skills', '/home/u/.agents/skills', '/opt/skills']);
	});

	test('follows the base separator on windows paths', () => {
		expect(skillRoots('C:\\proj', ['.claude/skills'], ['D:\\shared\\skills\\']))
			.toEqual(['C:\\proj\\.claude\\skills', 'D:\\shared\\skills']);
	});

	test('no base means nothing to scan', () => {
		expect(skillRoots('', ['.claude/skills'], ['x'])).toEqual([]);
	});
});

describe('formatSkills', () => {
	const skills: Skill[] = [
		{ name: 'pdf', description: 'Handles PDFs.\nUse for forms.', path: '/p/.claude/skills/pdf/SKILL.md' },
	];

	test('collapses descriptions and lists paths', () => {
		const out = formatSkills(skills, 'project');
		expect(out).toContain('<skills scope="project">');
		expect(out).toContain('- pdf: Handles PDFs. Use for forms.');
		expect(out).toContain('  /p/.claude/skills/pdf/SKILL.md');
	});

	test('empty list yields no macro text', () => {
		expect(formatSkills([], 'user')).toBe('');
	});
});

describe('skillsIn', () => {
	const tree: Record<string, Array<[string, boolean]>> = {
		'/root': [['pdf', true], ['group', true], ['broken', true]],
		'/root/pdf': [['SKILL.md', false]],
		'/root/group': [['nested', true]],
		'/root/group/nested': [['skill.md', false]],
		// 'broken' absent: readDir throws, the scan skips it
	};
	const files: Record<string, string> = {
		'/root/pdf/SKILL.md': '---\nname: pdf\ndescription: Handles PDFs\n---\n',
		'/root/group/nested/skill.md': '---\ndescription: grouped\n---\n',
	};
	const backend = {
		readDir: async (dir: string) => {
			const entries = tree[dir];
			if (!entries) throw new Error('no such dir');
			return entries.map(([name, isDirectory]) => ({ name, isDirectory }));
		},
		readText: async (path: string) => {
			if (!(path in files)) throw new Error('no such file');
			return files[path];
		},
	} as unknown as Backend;

	test('finds SKILL.md one level deep and grouped skills two deep', async () => {
		const skills = await skillsIn(backend, '/root');
		expect(skills.map(s => s.name).sort()).toEqual(['nested', 'pdf']);
		// lowercase skill.md matches; the path keeps on-disk casing, and a missing
		// frontmatter name falls back to the directory name
		expect(skills.find(s => s.name === 'nested')).toEqual({ name: 'nested', description: 'grouped', path: '/root/group/nested/skill.md' });
	});
});

test('joinPath normalizes separators', () => {
	expect(joinPath('C:\\proj\\', '.claude/skills')).toBe('C:\\proj\\.claude\\skills');
	expect(joinPath('/home/u', 'a/b')).toBe('/home/u/a/b');
});
