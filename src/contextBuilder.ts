import {App, TFile} from 'obsidian';
import {VaultIndex} from './vaultIndex';
import type {SearchCandidate} from './vaultIndex';

export interface ContextOptions {
	query: string;
	scopePaths: string[];
	maxChars?: number;
	maxFiles?: number;
	maxPerFile?: number;
	alreadySent?: Set<string>;
}

export interface ContextResult {
	files: ContextFile[];
	summary: string;
	includedPaths: Set<string>;
	totalChars: number;
}

export interface ContextFile {
	path: string;
	excerpt: string;
	reason: string;
	score: number;
}

export class ContextBuilder {
	constructor(
		private app: App,
		private vaultIndex: VaultIndex,
	) {}

	/**
	 * Build optimized context for a query.
	 * Uses metadata scoring + graph traversal to select relevant files,
	 * reads only those files, and produces compact excerpts.
	 */
	async buildContext(options: ContextOptions): Promise<ContextResult> {
		const {
			query,
			scopePaths,
			maxChars = 8000,
			maxFiles = 15,
			maxPerFile = 500,
			alreadySent = new Set<string>(),
		} = options;

		// Phase 1: Score candidates using VaultIndex pre-filter
		const candidates = this.vaultIndex.preFilter(query, scopePaths, maxFiles * 3);

		// Phase 2: Boost graph-connected files
		const boosted = this.applyGraphBoost(candidates, query, alreadySent);

		// Phase 3: Filter out already-sent files
		const fresh = boosted.filter(c => !alreadySent.has(c.note.path));

		// Phase 4: Token budget allocation
		const selected = this.fitBudget(fresh, maxFiles, maxChars, maxPerFile);

		// Phase 5: Read selected files and produce excerpts
		const files: ContextFile[] = [];
		let totalChars = 0;

		for (const candidate of selected) {
			const file = this.app.vault.getAbstractFileByPath(candidate.note.path);
			if (!(file instanceof TFile)) continue;

			const content = await this.app.vault.cachedRead(file);
			const excerpt = this.extractRelevantExcerpt(content, query, maxPerFile);

			files.push({
				path: candidate.note.path,
				excerpt,
				reason: candidate.matchReasons.join(', '),
				score: candidate.score,
			});
			totalChars += excerpt.length;
		}

		// Phase 6: Build compact summary
		const summary = this.buildSummary(files, query);
		const includedPaths = new Set(files.map(f => f.path));

		return {files, summary, includedPaths, totalChars};
	}

	/**
	 * Build context for a file-change trigger.
	 * Includes: changed file content, graph neighbors, folder siblings.
	 */
	async buildTriggerContext(
		changedPath: string,
		triggerContent: string,
		options?: Partial<ContextOptions>,
	): Promise<ContextResult> {
		return this.buildContext({
			query: triggerContent,
			scopePaths: options?.scopePaths ?? ['/'],
			maxChars: options?.maxChars ?? 4000,
			maxFiles: options?.maxFiles ?? 10,
			maxPerFile: options?.maxPerFile ?? 400,
			alreadySent: new Set([changedPath]),
		});
	}

	/**
	 * Build context for ghost-text completion.
	 * Includes: linked file summaries for the current file.
	 */
	buildGhostContext(currentFile: TFile): string {
		const linked = this.vaultIndex.getLinkedFiles(currentFile.path);
		if (linked.forward.length === 0) return '';

		const summaries = linked.forward.slice(0, 3).map(path => {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) return null;
			const meta = this.vaultIndex.getNoteMetadata(f);
			return `${meta.name} (${meta.tags.slice(0, 3).join(', ')})`;
		}).filter(Boolean);

		if (summaries.length === 0) return '';
		return `Linked: ${summaries.join('; ')}\n`;
	}

	private applyGraphBoost(
		candidates: SearchCandidate[],
		query: string,
		alreadySent: Set<string>,
	): SearchCandidate[] {
		const anchors = new Set<string>();
		for (const path of alreadySent) anchors.add(path);

		// Check if query mentions a known filename
		const allFiles = this.app.vault.getMarkdownFiles();
		for (const f of allFiles) {
			const name = f.basename.toLowerCase();
			if (name.length > 3 && query.toLowerCase().includes(name)) {
				anchors.add(f.path);
			}
		}

		if (anchors.size === 0) return candidates;

		const anchorLinks = new Set<string>();
		for (const anchor of anchors) {
			const linked = this.vaultIndex.getLinkedFiles(anchor);
			for (const p of linked.forward) anchorLinks.add(p);
			for (const p of linked.backward) anchorLinks.add(p);
		}

		return candidates.map(c => ({
			...c,
			score: anchorLinks.has(c.note.path) ? c.score + 3 : c.score,
			matchReasons: anchorLinks.has(c.note.path)
				? [...c.matchReasons, 'graph-linked']
				: c.matchReasons,
		})).sort((a, b) => b.score - a.score);
	}

	private fitBudget(
		candidates: SearchCandidate[],
		maxFiles: number,
		maxChars: number,
		maxPerFile: number,
	): SearchCandidate[] {
		const selected: SearchCandidate[] = [];
		let remaining = maxChars;

		for (const c of candidates) {
			if (selected.length >= maxFiles) break;
			const budget = Math.min(maxPerFile, remaining);
			if (budget <= 0) break;
			selected.push(c);
			remaining -= budget;
		}

		return selected;
	}

	private extractRelevantExcerpt(
		content: string,
		query: string,
		maxChars: number,
	): string {
		if (content.length <= maxChars) return content;

		const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1);
		const contentLower = content.toLowerCase();

		let bestIdx = 0;
		let bestScore = 0;
		for (const term of queryTerms) {
			const idx = contentLower.indexOf(term);
			if (idx >= 0) {
				bestIdx = idx;
				bestScore++;
			}
		}

		if (bestScore > 0) {
			const start = Math.max(0, bestIdx - Math.floor(maxChars / 3));
			const end = Math.min(content.length, start + maxChars);
			const raw = content.slice(start, end);

			const firstBreak = start > 0 ? raw.indexOf('\n') : 0;
			const lastBreak = end < content.length ? raw.lastIndexOf('\n') : raw.length;
			return raw.slice(
				firstBreak > 0 ? firstBreak + 1 : 0,
				lastBreak > 0 ? lastBreak : raw.length,
			);
		}

		const cut = content.slice(0, maxChars);
		const lastBreak = cut.lastIndexOf('\n');
		return lastBreak > maxChars * 0.75 ? cut.slice(0, lastBreak) : cut;
	}

	private buildSummary(files: ContextFile[], query: string): string {
		if (files.length === 0) return '';

		const lines = [
			`Context: ${files.length} relevant files for "${query}":`,
			...files.map(f => `- ${f.path} (${f.reason})`),
			'',
		];
		return lines.join('\n');
	}
}
