export type ImageCropMode = 'pixels' | 'normalized';

export interface ImageCropCoordinates {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

export interface ImageSize {
	width: number;
	height: number;
}

export interface CroppedImage {
	blob: Blob;
	coordinates: ImageCropCoordinates;
	source: ImageCropCoordinates;
	sourceSize: ImageSize;
	viewSize: ImageSize;
	outputSize: ImageSize;
}

const IMAGE_VIEW_EDGE = 1568;
const ZOOM_MAX_EDGE = 1568;
const ZOOM_MAX_PIXELS = 1_500_000;
const PNG_SIZE_RATIO = 1.5;

export function imageCropMode(model: string | undefined): ImageCropMode {
	return /(?:gpt-|claude|fable)/i.test(model ?? '') ? 'pixels' : 'normalized';
}

export function imageCropMime(pngSize: number, webpSize: number): 'image/png' | 'image/webp' {
	return pngSize <= webpSize * PNG_SIZE_RATIO ? 'image/png' : 'image/webp';
}

function encodeCanvas(canvas: HTMLCanvasElement, mime: 'image/png' | 'image/webp'): Promise<Blob | null> {
	return new Promise(resolve => canvas.toBlob(resolve, mime, mime === 'image/webp' ? 0.94 : undefined));
}

export function imageViewSize(width: number, height: number): ImageSize {
	const scale = Math.min(1, IMAGE_VIEW_EDGE / Math.max(width, height));
	return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export function zoomedCropSize(width: number, height: number): ImageSize {
	const scale = Math.max(1, Math.floor(Math.min(
		ZOOM_MAX_EDGE / Math.max(width, height),
		Math.sqrt(ZOOM_MAX_PIXELS / (width * height)),
	)));
	return { width: Math.max(1, width * scale), height: Math.max(1, height * scale) };
}

function cropValues(raw: unknown): unknown[] | undefined {
	if (Array.isArray(raw)) return raw;
	if (typeof raw === 'string') {
		const values = raw.match(/-?\d+(?:\.\d+)?/g);
		return values?.length === 4 ? values : undefined;
	}
	if (!raw || typeof raw !== 'object') return undefined;
	const value = raw as Record<string, unknown>;
	return [
		value.x1 ?? value.x_min ?? value.left,
		value.y1 ?? value.y_min ?? value.top,
		value.x2 ?? value.x_max ?? value.right,
		value.y2 ?? value.y_max ?? value.bottom,
	];
}

export function parseImageCrop(raw: unknown, bounds: ImageSize): ImageCropCoordinates | null {
	const values = cropValues(raw)?.map(Number);
	if (!values || values.length !== 4 || values.some(value => !Number.isFinite(value))) return null;

	let [x1, y1, x2, y2] = values;
	if (x1 > x2) [x1, x2] = [x2, x1];
	if (y1 > y2) [y1, y2] = [y2, y1];
	x1 = Math.max(0, Math.min(x1, bounds.width));
	y1 = Math.max(0, Math.min(y1, bounds.height));
	x2 = Math.max(0, Math.min(x2, bounds.width));
	y2 = Math.max(0, Math.min(y2, bounds.height));
	if (x1 === x2 || y1 === y2) return null;
	return { x1, y1, x2, y2 };
}

export async function cropImage(file: Blob, raw: unknown, mode: ImageCropMode): Promise<CroppedImage | { error: string }> {
	const bitmap = await createImageBitmap(file);
	try {
		const sourceSize = { width: bitmap.width, height: bitmap.height };
		const viewSize = imageViewSize(bitmap.width, bitmap.height);
		const bounds = mode === 'pixels' ? viewSize : { width: 1000, height: 1000 };
		const coordinates = parseImageCrop(raw, bounds);
		if (!coordinates) {
			const format = mode === 'pixels'
				? `pixel coordinates within 0,0:${viewSize.width},${viewSize.height}`
				: 'normalized coordinates within 0,0:1000,1000';
			return { error: `Error: invalid image crop. Use {x1, y1, x2, y2} with ${format}.` };
		}

		const source = {
			x1: Math.max(0, Math.floor(coordinates.x1 / bounds.width * bitmap.width)),
			y1: Math.max(0, Math.floor(coordinates.y1 / bounds.height * bitmap.height)),
			x2: Math.min(bitmap.width, Math.ceil(coordinates.x2 / bounds.width * bitmap.width)),
			y2: Math.min(bitmap.height, Math.ceil(coordinates.y2 / bounds.height * bitmap.height)),
		};
		const outputSize = zoomedCropSize(source.x2 - source.x1, source.y2 - source.y1);
		const canvas = document.createElement('canvas');
		canvas.width = outputSize.width;
		canvas.height = outputSize.height;
		const context = canvas.getContext('2d');
		if (!context) throw new Error('Canvas is unavailable');
		context.imageSmoothingEnabled = false;
		context.drawImage(
			bitmap,
			source.x1, source.y1, source.x2 - source.x1, source.y2 - source.y1,
			0, 0, outputSize.width, outputSize.height,
		);
		const [png, encodedWebp] = await Promise.all([
			encodeCanvas(canvas, 'image/png'),
			encodeCanvas(canvas, 'image/webp'),
		]);
		const webp = encodedWebp?.type === 'image/webp' ? encodedWebp : null;
		if (!png && !webp) throw new Error('Could not encode cropped image');
		const mime = png && webp ? imageCropMime(png.size, webp.size) : png ? 'image/png' : 'image/webp';
		const blob = mime === 'image/png' ? png! : webp!;
		console.info(`[image crop] selected ${mime} (PNG ${png?.size ?? 'failed'} bytes, WebP ${webp?.size ?? 'failed'} bytes)`);
		return { blob, coordinates, source, sourceSize, viewSize, outputSize };
	} finally {
		bitmap.close();
	}
}
