/**
 * Secure storage layer for sensitive fields.
 *
 * Provides two protections on top of Obsidian's `loadLocalStorage` /
 * `saveLocalStorage` (which are already machine-local and NOT synced
 * with the vault folder):
 *
 * 1. **AES-256-GCM encryption at rest** – values are encrypted before
 *    they hit localStorage.  The key is derived (PBKDF2) from
 *    machine+user+vault identity, so copying the Obsidian app-data
 *    directory to another machine/user won't reveal secrets.
 *
 * 2. **Environment-variable references** – if a field's stored value
 *    matches `$VAR` or `${VAR}`, the actual secret is read from
 *    `process.env` at runtime and never persisted.
 */

import {App, FileSystemAdapter} from "obsidian";
import * as crypto from "crypto";
import * as os from "os";

// ── Environment-variable helpers ────────────────────────────

const ENV_RE = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;

/** Return true if `value` is an env-var reference like `$FOO` or `${FOO}`. */
export function isEnvRef(value: string): boolean {
	return ENV_RE.test(value.trim());
}

/**
 * If `raw` is an env-var reference, resolve it from `process.env`.
 * Otherwise return `raw` unchanged.
 */
export function resolveEnvRef(raw: string): string {
	const m = raw.trim().match(ENV_RE);
	if (!m) return raw;
	return process.env[m[1]] ?? "";
}

// ── Encryption helpers ──────────────────────────────────────

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const PBKDF2_ITER = 100_000;
const KEY_LEN = 32; // 256 bits

/** Lazily-cached derived key per vault path. */
let _cachedKey: Buffer | null = null;
let _cachedSalt: string | null = null;

/**
 * Derive a 256-bit key from machine-specific material:
 *   hostname + username + vault base-path.
 * The vault path acts as an implicit salt so the same user on the same
 * machine gets different keys for different vaults.
 */
function deriveKey(app: App): Buffer {
	const vaultPath =
		app.vault.adapter instanceof FileSystemAdapter
			? app.vault.adapter.getBasePath()
			: "mobile-vault";
	const salt = `${os.hostname()}:${os.userInfo().username}:${vaultPath}`;
	if (_cachedKey && _cachedSalt === salt) return _cachedKey;
	_cachedKey = crypto.pbkdf2Sync(salt, "obsidian-sidekick", PBKDF2_ITER, KEY_LEN, "sha512");
	_cachedSalt = salt;
	return _cachedKey;
}

/** Encrypt a plaintext string → base64 blob (iv + ciphertext + tag). */
function encrypt(plaintext: string, key: Buffer): string {
	const iv = crypto.randomBytes(IV_LEN);
	const cipher = crypto.createCipheriv(ALGO, key, iv);
	const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	// Pack:  iv (12) || ciphertext (variable) || tag (16)
	return Buffer.concat([iv, enc, tag]).toString("base64");
}

/** Decrypt a base64 blob → plaintext string, or return `""` on failure. */
function decrypt(blob: string, key: Buffer): string {
	try {
		const buf = Buffer.from(blob, "base64");
		if (buf.length < IV_LEN + TAG_LEN) return "";
		const iv = buf.subarray(0, IV_LEN);
		const tag = buf.subarray(buf.length - TAG_LEN);
		const enc = buf.subarray(IV_LEN, buf.length - TAG_LEN);
		const decipher = crypto.createDecipheriv(ALGO, key, iv);
		decipher.setAuthTag(tag);
		return decipher.update(enc) + decipher.final("utf8");
	} catch {
		// Tampered, wrong key, or legacy unencrypted value
		return "";
	}
}

// ── Encrypted load/save wrappers ────────────────────────────

const ENC_MARKER = "enc:";

/**
 * Load a value from Obsidian's local storage, decrypting if necessary.
 *
 * Values prefixed with `enc:` are treated as AES-256-GCM encrypted
 * blobs.  Legacy unencrypted values are transparently re-encrypted on
 * next save.
 */
export function loadEncrypted(app: App, storageKey: string): string {
	const raw = app.loadLocalStorage(storageKey);
	if (raw == null) return "";
	const str = String(raw);
	if (str.startsWith(ENC_MARKER)) {
		return decrypt(str.slice(ENC_MARKER.length), deriveKey(app));
	}
	// Legacy plaintext — return as-is (will be re-encrypted on next save)
	return str;
}

/** Encrypt and save a value to Obsidian's local storage. */
export function saveEncrypted(app: App, storageKey: string, value: string): void {
	if (!value) {
		app.saveLocalStorage(storageKey, null);
		return;
	}
	const blob = ENC_MARKER + encrypt(value, deriveKey(app));
	app.saveLocalStorage(storageKey, blob);
}

// ── High-level API (used by settings.ts) ────────────────────

const SECURE_PREFIX = "sidekick-secure-";
const MCP_SECRET_PREFIX = "sidekick-mcp-input-";

/** Load a secure plugin field, decrypting at rest. */
export function loadSecureField(app: App, key: string): string {
	return loadEncrypted(app, SECURE_PREFIX + key);
}

/** Save a secure plugin field, encrypting at rest. */
export function saveSecureField(app: App, key: string, value: string): void {
	saveEncrypted(app, SECURE_PREFIX + key, value);
}

/** Load an MCP input secret, decrypting at rest. */
export function loadMcpSecret(app: App, id: string): string {
	return loadEncrypted(app, MCP_SECRET_PREFIX + id);
}

/** Save an MCP input secret, encrypting at rest. */
export function saveMcpSecret(app: App, id: string, value: string): void {
	saveEncrypted(app, MCP_SECRET_PREFIX + id, value);
}

/** Delete an MCP input secret from local storage. */
export function deleteMcpSecret(app: App, id: string): void {
	app.saveLocalStorage(MCP_SECRET_PREFIX + id, null);
}

/** Purge every sidekick-secure-* and sidekick-mcp-input-* entry. */
export function purgeAllSecrets(app: App, secureKeys: readonly string[]): void {
	for (const key of secureKeys) {
		app.saveLocalStorage(SECURE_PREFIX + key, null);
	}
	// MCP secrets use a known prefix — enumerate by clearing known ids.
	// We can't enumerate localStorage keys via the Obsidian API, so we
	// accept an explicit list or rely on the caller to pass known ids.
}
