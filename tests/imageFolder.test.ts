import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { listImagePaths, resolveImageUrl, setImageSource, type ImageSource } from '../src/helpers/imageFolder';

function directory(name: string, entries: Array<{ name: string; kind: string }> = []) {
	return {
		name,
		kind: 'directory',
		async *values() { yield* entries; },
	} as unknown as FileSystemDirectoryHandle;
}

const file = (name: string) => ({ name, kind: 'file' });
const source = (handle: FileSystemDirectoryHandle): ImageSource => ({ kind: 'handle', handle });

afterEach(() => { setImageSource(null); });

describe('image folder listing', () => {
	test('no folder gives an empty list', async () => {
		expect(await listImagePaths()).toEqual([]);
	});

	test('lists sorted relative image paths, retaining duplicate basenames', async () => {
		setImageSource(source(directory('images', [
			file('portrait.png'), file('notes.txt'), file('other.JPG'), file('.hidden.png'),
			directory('refs', [file('portrait.png'), file('sketch.webp')]),
		])));
		expect(await listImagePaths()).toEqual(['other.JPG', 'portrait.png', 'refs/portrait.png', 'refs/sketch.webp']);
	});

	test('shares one scan between concurrent requests and cached completions', async () => {
		let scans = 0;
		const handle = directory('images');
		(handle as any).values = async function* () { scans++; yield file('portrait.png'); };
		setImageSource(source(handle));
		const [first, second] = await Promise.all([listImagePaths(), listImagePaths()]);
		expect(first).toBe(second);
		expect(await listImagePaths()).toBe(first);
		expect(scans).toBe(1);
	});

	test('refreshes a stale listing but not an in-flight scan', async () => {
		const clock = spyOn(Date, 'now').mockReturnValue(1_000);
		try {
			const entries = [file('first.png')];
			setImageSource(source(directory('images', entries)));
			expect(await listImagePaths()).toEqual(['first.png']);
			entries.push(file('second.png'));
			clock.mockReturnValue(5_000);
			expect(await listImagePaths()).toEqual(['first.png']);
			clock.mockReturnValue(12_000);
			const [first, second] = await Promise.all([listImagePaths(), listImagePaths()]);
			expect(first).toEqual(['first.png', 'second.png']);
			expect(first).toBe(second);
		} finally {
			clock.mockRestore();
		}
	});

	test('discards a scan after the folder changes without replacing the new cache', async () => {
		let release!: () => void;
		const pending = new Promise<void>(resolve => { release = resolve; });
		const old = directory('old');
		(old as any).values = async function* () { await pending; yield file('old.png'); };
		setImageSource(source(old));
		const oldListing = listImagePaths();
		setImageSource(source(directory('new', [file('new.png')])));
		const newListing = await listImagePaths();
		release();
		expect(await oldListing).toEqual([]);
		expect(await listImagePaths()).toBe(newListing);
		expect(newListing).toEqual(['new.png']);
	});

	test('a failed scan is cached through the cooldown and then retried', async () => {
		const clock = spyOn(Date, 'now').mockReturnValue(1_000);
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			let scans = 0;
			const handle = directory('images');
			(handle as any).values = async function* () {
				if (++scans === 1) throw new Error('unreadable');
				yield file('portrait.png');
			};
			setImageSource(source(handle));
			expect(await listImagePaths()).toEqual([]);
			expect(await listImagePaths()).toEqual([]);
			expect(scans).toBe(1);
			clock.mockReturnValue(12_000);
			expect(await listImagePaths()).toEqual(['portrait.png']);
		} finally {
			clock.mockRestore();
			warn.mockRestore();
		}
	});

	test('encoded filenames resolve to the same file without reading during listing', async () => {
		let reads = 0;
		const name = "A image (1)#%.png";
		const handle = directory('images', [file(name)]);
		(handle as any).getFileHandle = async (requested: string) => {
			expect(requested).toBe(name);
			reads++;
			return { getFile: async () => new Blob(['image']) };
		};
		setImageSource(source(handle));
		expect(await listImagePaths()).toEqual([name]);
		expect(reads).toBe(0);
		const url = await resolveImageUrl('%41%20image%20%281%29%23%25.png');
		expect(url).toStartWith('blob:');
		expect(await resolveImageUrl(name)).toBe(url);
		expect(reads).toBe(1);
	});
});
