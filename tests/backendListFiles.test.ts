import { describe, expect, test } from 'bun:test';
import { listFiles, type Backend, type ExecOptions, type ExecResult } from '../src/helpers/backend';

function fakeBackend(files: string[], opts: { id?: string; git?: boolean } = {}) {
	let execCalls = 0;
	const backend = {
		id: opts.id ?? `test-${Math.random()}`,
		paths: { sep: '/', windows: false },
		exec: async (o: ExecOptions): Promise<ExecResult> => {
			execCalls++;
			const git = o.command?.startsWith('git ls-files') ?? false;
			if (git) {
				if (opts.git === false) return { stdout: '', stderr: '', exit_code: 128, duration_ms: 0 };
				return { stdout: files.join('\n'), stderr: '', exit_code: 0, duration_ms: 0 };
			}
			if (o.command?.startsWith('find .'))
				// The shell prunes directories during the walk; only surviving files arrive.
				return { stdout: files.filter(f => !f.includes('/go/pkg/')).join('\n'), stderr: '', exit_code: 0, duration_ms: 0 };
			return { stdout: '', stderr: '', exit_code: 0, duration_ms: 0 };
		},
	} as unknown as Backend;
	return { backend, execCalls: () => execCalls };
}

describe('listFiles', () => {
	test('uses git ls-files and drops pruned cache dirs', async () => {
		const { backend } = fakeBackend(['agents.md', 'src/main.go', 'go/pkg/mod/x@v1/m.go', 'a/go/pkg/mod/y.go']);
		expect(await listFiles(backend, '/proj')).toEqual(['agents.md', 'src/main.go']);
	});

	test('caches per backend+root briefly', async () => {
		const { backend, execCalls } = fakeBackend(['a.txt']);
		await listFiles(backend, '/proj');
		await listFiles(backend, '/proj');
		await listFiles(backend, '/other');
		expect(execCalls()).toBe(2);
	});

	test('find fallback prunes go/pkg but keeps go/src and a local pkg/', async () => {
		const files = [
			'./a.txt',
			'./go/pkg/mod/x@v1/m.go',   // pruned by -path '*/go/pkg'
			'./go/src/app/main.go',     // kept: only go/pkg is a cache
			'./pkg/realsrc/lib.go',     // kept: a bare pkg/ is often real source
		];
		const { backend } = fakeBackend(files, { git: false });
		const got = await listFiles(backend, '/proj');
		expect(got).not.toContain('go/pkg/mod/x@v1/m.go');
		expect(got).toContain('go/src/app/main.go');
		expect(got).toContain('pkg/realsrc/lib.go');
	});
});
