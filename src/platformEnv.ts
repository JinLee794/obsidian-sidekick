/**
 * Cross-platform helpers for spawning subprocesses from inside Electron.
 *
 * On macOS/Linux, GUI apps inherit only a minimal PATH (e.g.
 * `/usr/bin:/bin:/usr/sbin:/sbin`) and `HOME` is the home dir.
 * On Windows, the home dir lives in `USERPROFILE`, the PATH separator is `;`,
 * and binaries usually carry a `.exe` suffix.
 *
 * These helpers MUST stay free of `node:*` imports so the file remains safe
 * to import on Obsidian Mobile (where `process` is a thin polyfill).
 */

declare const process: {
	platform: string;
	env: Record<string, string | undefined>;
};

export const IS_WINDOWS = typeof process !== 'undefined' && process.platform === 'win32';

/** PATH list separator (`;` on Windows, `:` elsewhere). */
export const PATH_SEP = IS_WINDOWS ? ';' : ':';

/** Executable suffix (`.exe` on Windows, `''` elsewhere). */
export const EXE_SUFFIX = IS_WINDOWS ? '.exe' : '';

/** Cross-platform user home directory (USERPROFILE on Windows, HOME elsewhere). */
export function getHomeDir(): string {
	if (typeof process === 'undefined') return '';
	if (IS_WINDOWS) {
		return process.env['USERPROFILE'] || process.env['HOME'] || '';
	}
	return process.env['HOME'] || '';
}

/**
 * Common bin/script directories that Electron-launched processes may need
 * but don't get from the inherited environment.
 *
 * On Windows we deliberately keep this list small: most CLIs (gh, az, agency)
 * either install themselves on the system PATH or live under
 * `%LOCALAPPDATA%\Programs\...`, which is already exported in `PATH`.
 */
export function getDefaultBinDirs(): string[] {
	const home = getHomeDir();
	if (IS_WINDOWS) {
		const dirs: string[] = [];
		const localAppData = process.env['LOCALAPPDATA'];
		const programFiles = process.env['ProgramFiles'] || process.env['PROGRAMFILES'];
		const programFilesX86 = process.env['ProgramFiles(x86)'] || process.env['PROGRAMFILES(X86)'];
		if (localAppData) {
			dirs.push(`${localAppData}\\Programs\\GitHub CLI`);
			dirs.push(`${localAppData}\\Microsoft\\WindowsApps`);
		}
		if (programFiles) {
			dirs.push(`${programFiles}\\GitHub CLI`);
			dirs.push(`${programFiles}\\Microsoft SDKs\\Azure\\CLI2\\wbin`);
		}
		if (programFilesX86) {
			dirs.push(`${programFilesX86}\\Microsoft SDKs\\Azure\\CLI2\\wbin`);
		}
		if (home) {
			dirs.push(`${home}\\.local\\bin`);
		}
		return dirs;
	}
	const dirs = ['/usr/local/bin', '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/sbin'];
	if (home) {
		dirs.push(`${home}/.local/bin`);
		dirs.push(`${home}/.nvm/current/bin`);
	}
	return dirs;
}

/**
 * Build a PATH string suitable for spawning a child process from Electron.
 * Prepends `extraDirs` (and `getDefaultBinDirs()` when `includeDefaults`
 * is true) to the inherited `process.env.PATH`, using the OS-appropriate
 * separator.
 */
export function buildSearchPath(extraDirs: string[] = [], includeDefaults = true): string {
	const dirs = includeDefaults ? [...extraDirs, ...getDefaultBinDirs()] : [...extraDirs];
	const currentPath = (typeof process !== 'undefined' && process.env['PATH']) || '';
	return [...dirs.filter(Boolean), currentPath].join(PATH_SEP);
}

/**
 * Build a `{ ...process.env, PATH: <search path> }` object for child_process
 * APIs. `extraDirs` are prepended ahead of the default bin dirs.
 */
export function buildSpawnEnv(extraDirs: string[] = []): Record<string, string> {
	const env: Record<string, string> = {};
	if (typeof process !== 'undefined') {
		for (const [k, v] of Object.entries(process.env)) {
			if (v !== undefined) env[k] = v;
		}
	}
	env['PATH'] = buildSearchPath(extraDirs);
	return env;
}
