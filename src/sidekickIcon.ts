import {addIcon} from 'obsidian';

/** Lucide icon name used by default (matches the original hardcoded value). */
export const DEFAULT_ICON_NAME = 'brain';

/** Internal id under which a user-uploaded PNG is registered with Obsidian. */
export const CUSTOM_ICON_ID = 'sidekick-custom';

/** Settings value that selects the custom uploaded icon. */
export const CUSTOM_ICON_SETTING_VALUE = 'custom';

/** Curated list of Lucide icons offered in the picker. */
export const ICON_PRESETS: ReadonlyArray<{value: string; label: string}> = [
	{value: 'brain', label: 'Brain (default)'},
	{value: 'bot', label: 'Bot'},
	{value: 'sparkles', label: 'Sparkles'},
	{value: 'message-circle', label: 'Message'},
	{value: 'wand-2', label: 'Wand'},
	{value: 'zap', label: 'Zap'},
	{value: 'lightbulb', label: 'Lightbulb'},
	{value: 'star', label: 'Star'},
	{value: 'rocket', label: 'Rocket'},
	{value: 'eye', label: 'Eye'},
	{value: 'compass', label: 'Compass'},
	{value: 'glasses', label: 'Glasses'},
	{value: 'feather', label: 'Feather'},
	{value: 'graduation-cap', label: 'Graduation cap'},
	{value: 'flame', label: 'Flame'},
	{value: 'cpu', label: 'CPU'},
	{value: 'activity', label: 'Activity'},
];

/** Max bytes accepted for the raw PNG upload (256 KB). */
export const MAX_CUSTOM_ICON_BYTES = 256 * 1024;

/** Pixel dimensions used when downscaling an uploaded PNG. */
export const CUSTOM_ICON_TARGET_SIZE = 64;

/**
 * Register the custom icon (when applicable) and return the icon name that
 * should be passed to `setIcon` / `addRibbonIcon` / `getIcon` everywhere.
 */
export function registerSidekickIcon(iconName: string, customDataUrl: string): string {
	if (iconName === CUSTOM_ICON_SETTING_VALUE && customDataUrl) {
		// Obsidian's addIcon takes the inner SVG content; default viewBox is 0 0 100 100.
		const escaped = customDataUrl.replace(/"/g, '&quot;');
		addIcon(
			CUSTOM_ICON_ID,
			`<image href="${escaped}" x="0" y="0" width="100" height="100" preserveAspectRatio="xMidYMid meet" />`,
		);
		return CUSTOM_ICON_ID;
	}
	return iconName || DEFAULT_ICON_NAME;
}

/**
 * Read a user-supplied PNG file, downscale it to a square thumbnail, and
 * return a base64 data URL suitable for storing in `data.json`.
 *
 * Throws when the file is too large, not a PNG, or cannot be decoded.
 */
export async function readPngAsDataUrl(file: File): Promise<string> {
	if (!/png$/i.test(file.type) && !/\.png$/i.test(file.name)) {
		throw new Error('Only PNG files are supported.');
	}
	if (file.size > MAX_CUSTOM_ICON_BYTES) {
		throw new Error(`PNG is too large (max ${Math.round(MAX_CUSTOM_ICON_BYTES / 1024)} KB).`);
	}

	const rawDataUrl = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result ?? ''));
		reader.onerror = () => reject(reader.error ?? new Error('Failed to read file.'));
		reader.readAsDataURL(file);
	});

	const img = await new Promise<HTMLImageElement>((resolve, reject) => {
		const el = new Image();
		el.onload = () => resolve(el);
		el.onerror = () => reject(new Error('Failed to decode PNG.'));
		el.src = rawDataUrl;
	});

	const canvas = document.createElement('canvas');
	canvas.width = CUSTOM_ICON_TARGET_SIZE;
	canvas.height = CUSTOM_ICON_TARGET_SIZE;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Canvas 2D context unavailable.');
	ctx.clearRect(0, 0, canvas.width, canvas.height);

	// Preserve aspect ratio, centred.
	const scale = Math.min(canvas.width / img.width, canvas.height / img.height);
	const w = img.width * scale;
	const h = img.height * scale;
	const x = (canvas.width - w) / 2;
	const y = (canvas.height - h) / 2;
	ctx.drawImage(img, x, y, w, h);

	return canvas.toDataURL('image/png');
}
