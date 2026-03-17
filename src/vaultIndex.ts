import {App, TFile, normalizePath} from 'obsidian';
import type {CachedMetadata} from 'obsidian';

export interface NoteMetadata {
	path: string;
	name: string;
	folder: string;
	tags: string[];
	aliases: string[];
	headings: string[];
	links: string[];
	backlinks: string[];
	frontmatter: Record<string, unknown> | undefined;
	mtime: number;
	size: number;
}

export interface SearchCandidate {
	note: NoteMetadata;
	score: number;
	matchReasons: string[];
}

export class VaultIndex {
	constructor(private app: App) {}

	/** Get metadata for a single file (from metadataCache). */
	getNoteMetadata(file: TFile): NoteMetadata {
		const cache = this.app.metadataCache.getFileCache(file);
		return this.buildNoteMetadata(file, cache);
	}

	/** Get metadata for all markdown files within a scope (folder paths). */
	getNotesInScope(scopePaths: string[]): NoteMetadata[] {
		const files = this.app.vault.getMarkdownFiles();
		const inScope = files.filter(f => this.isInScope(f.path, scopePaths));
		return inScope.map(f => {
			const cache = this.app.metadataCache.getFileCache(f);
			return this.buildNoteMetadata(f, cache);
		});
	}

	/**
	 * Local pre-filter: score notes against a query using metadata only.
	 * No file content read, no LLM call.
	 * Returns candidates sorted by score (descending).
	 */
	preFilter(query: string, scopePaths: string[], limit = 25): SearchCandidate[] {
		const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
		if (queryTerms.length === 0) return [];

		const notes = this.getNotesInScope(scopePaths);
		const candidates: SearchCandidate[] = [];

		for (const note of notes) {
			let score = 0;
			const reasons: string[] = [];

			// 1. Filename match (highest weight)
			const nameLower = note.name.toLowerCase();
			for (const term of queryTerms) {
				if (nameLower.includes(term)) {
					score += 5;
					reasons.push(`filename:${term}`);
				}
			}

			// 2. Alias match
			for (const alias of note.aliases) {
				const aliasLower = alias.toLowerCase();
				for (const term of queryTerms) {
					if (aliasLower.includes(term)) {
						score += 4;
						reasons.push(`alias:${term}`);
					}
				}
			}

			// 3. Tag match
			for (const tag of note.tags) {
				const tagLower = tag.toLowerCase().replace('#', '');
				for (const term of queryTerms) {
					if (tagLower.includes(term)) {
						score += 3;
						reasons.push(`tag:${tag}`);
					}
				}
			}

			// 4. Heading match
			for (const heading of note.headings) {
				const headingLower = heading.toLowerCase();
				for (const term of queryTerms) {
					if (headingLower.includes(term)) {
						score += 2;
						reasons.push(`heading:${heading}`);
					}
				}
			}

			// 5. Folder path match
			const folderLower = note.folder.toLowerCase();
			for (const term of queryTerms) {
				if (folderLower.includes(term)) {
					score += 1;
					reasons.push(`folder:${note.folder}`);
				}
			}

			// 6. Recency bonus (modified within last 7 days)
			const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
			if (note.mtime > weekAgo) {
				score += 1;
				reasons.push('recent');
			}

			if (score > 0) {
				candidates.push({note, score, matchReasons: reasons});
			}
		}

		candidates.sort((a, b) => b.score - a.score || b.note.mtime - a.note.mtime);
		return limit ? candidates.slice(0, limit) : candidates;
	}

	/**
	 * Get files that link to or from a given file path.
	 * Uses metadataCache.resolvedLinks.
	 */
	getLinkedFiles(filePath: string): {forward: string[]; backward: string[]} {
		const resolved = this.app.metadataCache.resolvedLinks;
		const forward: string[] = [];
		const backward: string[] = [];

		// Forward links from this file
		const outgoing = resolved[filePath];
		if (outgoing) {
			for (const target of Object.keys(outgoing)) {
				forward.push(target);
			}
		}

		// Backward links to this file
		for (const [source, targets] of Object.entries(resolved)) {
			if (source !== filePath && targets[filePath] !== undefined) {
				backward.push(source);
			}
		}

		return {forward, backward};
	}

	/** Get all unique tags within a scope. */
	getTagsInScope(scopePaths: string[]): Map<string, number> {
		const tagCounts = new Map<string, number>();
		const notes = this.getNotesInScope(scopePaths);
		for (const note of notes) {
			for (const tag of note.tags) {
				tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
			}
		}
		return tagCounts;
	}

	private buildNoteMetadata(file: TFile, cache: CachedMetadata | null): NoteMetadata {
		const tags: string[] = [];
		const aliases: string[] = [];
		const headings: string[] = [];
		const links: string[] = [];

		if (cache) {
			// Frontmatter tags
			if (cache.frontmatter?.tags) {
				const fmTags = cache.frontmatter.tags;
				if (Array.isArray(fmTags)) {
					tags.push(...fmTags.map((t: string) => `#${t.replace(/^#/, '')}`));
				} else if (typeof fmTags === 'string') {
					tags.push(`#${fmTags.replace(/^#/, '')}`);
				}
			}

			// Inline tags
			if (cache.tags) {
				for (const t of cache.tags) {
					if (!tags.includes(t.tag)) tags.push(t.tag);
				}
			}

			// Aliases
			if (cache.frontmatter?.aliases) {
				const fmAliases = cache.frontmatter.aliases;
				if (Array.isArray(fmAliases)) {
					aliases.push(...fmAliases);
				} else if (typeof fmAliases === 'string') {
					aliases.push(fmAliases);
				}
			}

			// Headings
			if (cache.headings) {
				for (const h of cache.headings) {
					headings.push(h.heading);
				}
			}

			// Forward links
			if (cache.links) {
				for (const l of cache.links) {
					const resolved = this.app.metadataCache.getFirstLinkpathDest(l.link, file.path);
					if (resolved) links.push(resolved.path);
				}
			}
		}

		// Backlinks
		const backlinks: string[] = [];
		const resolvedLinks = this.app.metadataCache.resolvedLinks;
		for (const [source, targets] of Object.entries(resolvedLinks)) {
			if (source !== file.path && targets[file.path] !== undefined) {
				backlinks.push(source);
			}
		}

		const folder = file.parent?.path ?? '';

		return {
			path: file.path,
			name: file.basename,
			folder,
			tags,
			aliases,
			headings,
			links,
			backlinks,
			frontmatter: cache?.frontmatter as Record<string, unknown> | undefined,
			mtime: file.stat.mtime,
			size: file.stat.size,
		};
	}

	private isInScope(filePath: string, scopePaths: string[]): boolean {
		if (scopePaths.length === 0) return true;
		for (const scope of scopePaths) {
			if (scope === '/' || scope === '') return true;
			const normalized = normalizePath(scope);
			if (filePath === normalized || filePath.startsWith(normalized + '/')) return true;
		}
		return false;
	}
}
