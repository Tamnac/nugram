import doneUrl from '../assets/done.wav';
import permissionUrl from '../assets/permission.wav';
import infoUrl from '../assets/info.wav';
import errorUrl from '../assets/error.wav';
import timerUrl from '../assets/timer.wav';

export type SoundType = 'done' | 'permission' | 'info' | 'error' | 'timer';

const URLS: Record<SoundType, string> = { done: doneUrl, permission: permissionUrl, info: infoUrl, error: errorUrl, timer: timerUrl };

const cache = new Map<string, HTMLAudioElement>();

export function playSound(type: SoundType) {
	const url = URLS[type];
	let audio = cache.get(url);
	if (!audio) {
		audio = new Audio(url);
		cache.set(url, audio);
	}
	audio.currentTime = 0;
	audio.play().catch(() => {});
}
