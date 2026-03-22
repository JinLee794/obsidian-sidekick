/**
 * Ghost-text autocomplete extension for CodeMirror 6.
 *
 * Shows translucent inline suggestions (similar to GitHub Copilot) that the
 * user can accept with Tab or dismiss with Escape. Suggestions are fetched
 * from the Copilot SDK via CopilotService.chat().
 */

import {
	StateField,
	StateEffect,
	type Extension,
	type EditorState,
	Prec,
} from '@codemirror/state';
import {
	Decoration,
	type DecorationSet,
	EditorView,
	WidgetType,
	type ViewUpdate,
	keymap,
	gutter,
	GutterMarker,
} from '@codemirror/view';
import {setIcon, Menu, Notice, TFile} from 'obsidian';
import type {HeadingCache} from 'obsidian';
import type SidekickPlugin from '../main';
import {buildSidekickMenu} from './editorMenu';

/* ── Constants ───────────────────────────────────────────────── */

/** Debounce delay (ms) after typing stops before requesting a completion. */
const DEBOUNCE_MS = 400;

/** Minimum characters on the current line before triggering. */
const MIN_LINE_CHARS = 3;

/** Number of context lines to send before and after the cursor. */
const CONTEXT_LINES = 30;

/** Maximum characters to send as context to the model. */
const MAX_CONTEXT_CHARS = 3000;

/** Character budget split: 60% before cursor, 40% after. */
const BEFORE_RATIO = 0.6;
const AFTER_RATIO = 0.4;

/** Character budget reserved for the context header. */
const HEADER_BUDGET = 200;

/** System prompt sent once when the completion session is created. */
const SYSTEM_MESSAGE =
	'You are an inline code/text completion engine inside a Markdown editor. ' +
	'Return ONLY the raw continuation text. No markdown fences, no explanation, ' +
	'no repeating existing text. Keep suggestions short (1-2 lines max).';

/* ── State effects & field ───────────────────────────────────── */

/** Show a ghost-text suggestion at a given position. */
const showGhost = StateEffect.define<{pos: number; text: string}>();

/** Clear the current ghost-text suggestion. */
const clearGhost = StateEffect.define<null>();

/** Signal that a completion fetch started / stopped. */
export const setFetching = StateEffect.define<boolean>();

/** Trigger an on-demand autocomplete (bypasses the enabled setting). */
export const triggerComplete = StateEffect.define<null>();

/** Whether a completion request is currently in-flight. */
const fetchingField = StateField.define<boolean>({
	create: () => false,
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(setFetching)) return e.value;
		}
		return value;
	},
});

interface GhostState {
	pos: number;
	text: string;
	deco: DecorationSet;
}

/** Widget that renders the ghost suggestion inline. */
class GhostTextWidget extends WidgetType {
	constructor(readonly text: string) {
		super();
	}
	toDOM(): HTMLElement {
		const span = document.createElement('span');
		span.className = 'sidekick-ghost-text';
		span.textContent = this.text;
		return span;
	}
	eq(other: GhostTextWidget): boolean {
		return this.text === other.text;
	}
}

function buildDecoSet(pos: number, text: string): DecorationSet {
	return Decoration.set([
		Decoration.widget({widget: new GhostTextWidget(text), side: 1}).range(pos),
	]);
}

const ghostField = StateField.define<GhostState | null>({
	create: () => null,
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(showGhost)) {
				return {
					pos: e.value.pos,
					text: e.value.text,
					deco: buildDecoSet(e.value.pos, e.value.text),
				};
			}
			if (e.is(clearGhost)) return null;
		}
		// Clear ghost on any document change or cursor movement
		if (value && (tr.docChanged || tr.selection)) return null;
		return value;
	},
	provide: (f) => EditorView.decorations.from(f, (v) => v?.deco ?? Decoration.none),
});

/* ── Gutter indicator ────────────────────────────────────────── */

/**
 * GutterMarker that renders the brain-icon button on the active line.
 * CM6 handles alignment natively — works in bullets, tables, headings, etc.
 */
class SidekickGutterMarker extends GutterMarker {
	private plugin: SidekickPlugin;
	private view: EditorView;

	constructor(plugin: SidekickPlugin, view: EditorView) {
		super();
		this.plugin = plugin;
		this.view = view;
	}

	toDOM(): HTMLElement {
		const btn = document.createElement('button');
		btn.className = 'sidekick-autocomplete-indicator';
		btn.setAttribute('aria-label', 'Sidekick autocomplete');
		setIcon(btn, 'brain');

		// Toggle loading state based on fetchingField
		const fetching = this.view.state.field(fetchingField);
		btn.classList.toggle('is-loading', fetching);

		btn.addEventListener('click', (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			showIndicatorMenu(this.plugin, this.view, btn);
		});

		btn.addEventListener('dblclick', (e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			const ghost = this.view.state.field(ghostField);
			if (ghost) {
				this.view.dispatch({
					changes: {from: ghost.pos, insert: ghost.text},
					selection: {anchor: ghost.pos + ghost.text.length},
					effects: clearGhost.of(null),
				});
			}
		});
		return btn;
	}

	eq(_other: SidekickGutterMarker): boolean {
		// Always re-render so the loading state stays fresh
		return false;
	}
}

/**
 * Build the CM6 gutter extension that shows a brain icon on the active
 * cursor line. CM6 positions gutter markers automatically for all line
 * types including bullet points, tables, headings, blockquotes, etc.
 */
function buildIndicatorGutter(plugin: SidekickPlugin): Extension {
	return gutter({
		class: 'sidekick-gutter',
		lineMarker(view: EditorView, line) {
			const cursorLine = view.state.doc.lineAt(view.state.selection.main.head);
			const thisLine = view.state.doc.lineAt(line.from);
			if (thisLine.number === cursorLine.number) {
				return new SidekickGutterMarker(plugin, view);
			}
			return null;
		},
		lineMarkerChange(update: ViewUpdate): boolean {
			// Re-evaluate markers when cursor moves, doc changes, or fetching state flips
			if (update.selectionSet || update.docChanged) return true;
			for (const e of update.transactions) {
				for (const eff of e.effects) {
					if (eff.is(setFetching)) return true;
				}
			}
			return false;
		},
	});
}

/* ── Menu actions ────────────────────────────────────────────── */

/** Show the indicator context menu anchored to the button element. */
function showIndicatorMenu(plugin: SidekickPlugin, view: EditorView, button: HTMLElement): void {
	const menu = new Menu();
	buildSidekickMenu(menu, plugin, view);
	const rect = button.getBoundingClientRect();
	menu.showAtPosition({x: rect.right + 4, y: rect.top});
}

/* ── Markdown-aware insert prefix ─────────────────────────────── */

/**
 * Compute a prefix string to prepend before ghost text so it integrates
 * naturally with the surrounding Markdown structure.
 *
 * Rules (evaluated in order):
 *  1. If the ghost text already starts with whitespace → no prefix.
 *  2. If the cursor is at (or near) the end of a heading, table row,
 *     bullet/numbered-list item, or blockquote → newline.
 *  3. If the character immediately before the cursor is sentence-ending
 *     punctuation (. ! ?) → space.
 */
function computeInsertPrefix(state: EditorState, pos: number, ghostText: string): string {
	// Don't double-up if the completion already starts with whitespace
	if (/^[\s\n]/.test(ghostText)) return '';

	const line = state.doc.lineAt(pos);
	const textBeforeCursor = line.text.slice(0, pos - line.from);

	// Only apply block-level (newline) rules when the cursor is at/near end of line
	const atLineEnd = pos >= line.to - 1;

	if (atLineEnd && textBeforeCursor.trim().length > 0) {
		const trimmed = textBeforeCursor.trim();

		// Heading: # … through ###### …
		if (/^#{1,6}\s/.test(trimmed)) return '\n';

		// Table row: starts with |
		if (/^\|/.test(trimmed)) return '\n';

		// Unordered bullet: -, *, +
		if (/^[-*+]\s/.test(trimmed)) return '\n';

		// Ordered list: 1. 2. etc.
		if (/^\d+\.\s/.test(trimmed)) return '\n';

		// Blockquote
		if (/^>/.test(trimmed)) return '\n';

		// Horizontal rule (---, ***, ___)
		if (/^([-*_])\1{2,}$/.test(trimmed)) return '\n';
	}

	// Sentence-ending punctuation → space
	if (/[.!?]$/.test(textBeforeCursor)) return ' ';

	return '';
}

/* ── Structure-aware truncation ───────────────────────────────── */

/**
 * Truncate text at a clean boundary (paragraph, heading, sentence, or word)
 * instead of slicing mid-word.
 */
function truncateAtBoundary(text: string, maxChars: number, direction: 'before' | 'after'): string {
	if (text.length <= maxChars) return text;

	if (direction === 'before') {
		const cut = text.slice(-maxChars);
		const breaks = [
			cut.indexOf('\n\n'),
			cut.indexOf('\n#'),
			cut.search(/\.\s/),
			cut.indexOf(' '),
		];
		const breakIdx = breaks.find(i => i > 0 && i < maxChars / 4);
		return breakIdx !== undefined ? cut.slice(breakIdx) : cut;
	} else {
		const cut = text.slice(0, maxChars);
		const breaks = [
			cut.lastIndexOf('\n\n'),
			cut.lastIndexOf('\n#'),
			cut.search(/\.\s[^.]*$/),
			cut.lastIndexOf(' '),
		];
		const breakIdx = breaks.find(i => i > maxChars * 3 / 4);
		return breakIdx !== undefined ? cut.slice(0, breakIdx) : cut;
	}
}

/* ── Context header (file identity + heading path) ───────────── */

function buildHeadingPath(headings: HeadingCache[], cursorLine: number): string {
	const stack: string[] = [];
	for (const h of headings) {
		if (h.position.start.line >= cursorLine) break;
		while (stack.length >= h.level) stack.pop();
		stack.push(h.heading);
	}
	return stack.join(' > ');
}

function buildContextHeader(state: EditorState, plugin: SidekickPlugin): string {
	const file = plugin.app.workspace.getActiveFile();
	if (!file) return '';

	const cache = plugin.app.metadataCache.getFileCache(file);
	if (!cache) return '';

	const parts: string[] = [];

	parts.push(`File: ${file.path}`);

	if (cache.frontmatter) {
		const tags = cache.frontmatter.tags;
		const type = cache.frontmatter.type;
		if (tags) parts.push(`Tags: ${Array.isArray(tags) ? tags.join(', ') : tags}`);
		if (type) parts.push(`Type: ${type}`);
	}

	if (cache.headings?.length) {
		const cursorLine = state.doc.lineAt(state.selection.main.head).number;
		const headingPath = buildHeadingPath(cache.headings, cursorLine);
		if (headingPath) parts.push(`Section: ${headingPath}`);
	}

	// Linked-file summaries (P4: ghost-text context)
	const resolved = plugin.app.metadataCache.resolvedLinks;
	const outgoing = resolved[file.path];
	if (outgoing) {
		const linkedNames = Object.keys(outgoing).slice(0, 3).map(path => {
			const f = plugin.app.vault.getAbstractFileByPath(path);
			if (!(f instanceof TFile)) return null;
			const lCache = plugin.app.metadataCache.getFileCache(f);
			const lTags = lCache?.frontmatter?.tags;
			const tagStr = lTags
				? ` (${(Array.isArray(lTags) ? lTags : [lTags]).slice(0, 3).join(', ')})`
				: '';
			return f.basename + tagStr;
		}).filter(Boolean);
		if (linkedNames.length > 0) {
			parts.push(`Linked: ${linkedNames.join('; ')}`);
		}
	}

	const header = parts.length > 0 ? `[${parts.join(' | ')}]\n` : '';
	return header.length > HEADER_BUDGET ? header.slice(0, HEADER_BUDGET) : header;
}

/* ── Prompt builder ──────────────────────────────────────────── */

function buildPrompt(state: EditorState, plugin: SidekickPlugin): string {
	const cursor = state.selection.main.head;
	const doc = state.doc;
	const cursorLine = doc.lineAt(cursor);

	const startLine = Math.max(1, cursorLine.number - CONTEXT_LINES);
	const endLine = Math.min(doc.lines, cursorLine.number + CONTEXT_LINES);

	let before = '';
	for (let i = startLine; i <= cursorLine.number; i++) {
		const line = doc.line(i);
		if (i === cursorLine.number) {
			before += line.text.slice(0, cursor - line.from);
		} else {
			before += line.text + '\n';
		}
	}

	let after = '';
	if (cursor < cursorLine.to) {
		after += cursorLine.text.slice(cursor - cursorLine.from);
	}
	for (let i = cursorLine.number + 1; i <= endLine; i++) {
		after += '\n' + doc.line(i).text;
	}

	const header = buildContextHeader(state, plugin);
	const contentBudget = MAX_CONTEXT_CHARS - header.length;
	const beforeBudget = Math.floor(contentBudget * BEFORE_RATIO);
	const afterBudget = Math.floor(contentBudget * AFTER_RATIO);

	before = truncateAtBoundary(before, beforeBudget, 'before');
	after = truncateAtBoundary(after, afterBudget, 'after');

	return (
		'Continue the following text from exactly where it stops. ' +
		'Return ONLY the continuation text, no explanation, no markdown fences, no repeating existing text.\n\n' +
		header +
		'TEXT BEFORE CURSOR:\n' +
		before +
		'\n<<<CURSOR>>>\n' +
		after
	);
}

/* ── Extension builder ───────────────────────────────────────── */

/**
 * Build the CM6 extension array for ghost-text autocomplete.
 * Call `plugin.registerEditorExtension(buildGhostTextExtension(plugin))`.
 */
export function buildGhostTextExtension(plugin: SidekickPlugin): Extension {
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;
	let abortController: AbortController | null = null;
	let prewarmed = false;

	/** Cancel any in-flight request and pending debounce. */
	function cancelPending(): void {
		if (debounceTimer !== null) {
			clearTimeout(debounceTimer);
			debounceTimer = null;
		}
		if (abortController) {
			abortController.abort();
			abortController = null;
		}
	}

	/** Force an immediate completion request (bypasses enabled check). */
	function forceComplete(view: EditorView): void {
		cancelPending();

		if (!plugin.copilot) { new Notice('Copilot is not configured.'); return; }

		// Pre-warm
		if (!prewarmed) {
			prewarmed = true;
			void plugin.copilot.ensureConnected().catch(() => { /* ignore */ });
		}

		const sel = view.state.selection.main;
		if (!sel.empty) { new Notice('Sidekick: place cursor without selection.'); return; }

		const version = view.state.doc.length;
		void fetchCompletion(view, version);
	}

	/** Trigger a completion request after the debounce period. */
	function scheduleFetch(view: EditorView): void {
		cancelPending();

		// Guard: feature must be enabled
		if (!plugin.settings.autocompleteEnabled) return;

		// Guard: copilot must be available
		if (!plugin.copilot) return;

		// Pre-warm: ensure the connection is ready before the first real request
		if (!prewarmed) {
			prewarmed = true;
			void plugin.copilot.ensureConnected().catch(() => { /* ignore */ });
		}

		// Guard: must have a single cursor (no selection)
		const sel = view.state.selection.main;
		if (!sel.empty) return;

		// Guard: current line must have enough content
		const line = view.state.doc.lineAt(sel.head);
		const lineText = line.text.slice(0, sel.head - line.from).trim();
		if (lineText.length < MIN_LINE_CHARS) return;

		const version = view.state.doc.length; // cheap proxy for "version"

		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			void fetchCompletion(view, version);
		}, DEBOUNCE_MS);
	}

	/** Perform the actual LLM call and dispatch the result. */
	async function fetchCompletion(view: EditorView, version: number): Promise<void> {
		abortController = new AbortController();
		const signal = abortController.signal;

		// Signal fetching started
		view.dispatch({effects: setFetching.of(true)});

		try {
			const prompt = buildPrompt(view.state, plugin);
			const model = plugin.settings.inlineModel || undefined;

			const result = await plugin.copilot!.chat({
				prompt,
				model,
				systemMessage: SYSTEM_MESSAGE,
			});

			// Abort guard: check if we were cancelled or document changed
			if (signal.aborted) return;
			if (view.state.doc.length !== version) return;

			const text = result?.trim();
			if (!text) return;

			const cursorPos = view.state.selection.main.head;
			const prefix = computeInsertPrefix(view.state, cursorPos, text);
			view.dispatch({effects: showGhost.of({pos: cursorPos, text: prefix + text})});
		} catch {
			// Request failed or was aborted — silently ignore
		} finally {
			if (abortController?.signal === signal) {
				abortController = null;
			}
			// Signal fetching stopped (only if view is still alive)
			try {
				view.dispatch({effects: setFetching.of(false)});
			} catch { /* view may have been destroyed */ }
		}
	}

	/* ── Keymap: Tab accepts, Escape dismisses ──────────────── */

	const ghostKeymap = Prec.highest(
		keymap.of([
			{
				key: 'Tab',
				run(view) {
					const ghost = view.state.field(ghostField);
					if (!ghost) return false;
					// Insert the ghost text at the stored position
					view.dispatch({
						changes: {from: ghost.pos, insert: ghost.text},
						selection: {anchor: ghost.pos + ghost.text.length},
						effects: clearGhost.of(null),
					});
					return true; // handled — prevent default Tab
				},
			},
			{
				key: 'Escape',
				run(view) {
					const ghost = view.state.field(ghostField);
					if (!ghost) return false;
					view.dispatch({effects: clearGhost.of(null)});
					return true;
				},
			},
		]),
	);

	/* ── Listener: trigger fetch on document changes ─────────── */

	const listener = EditorView.updateListener.of((update) => {
		if (update.docChanged) {
			scheduleFetch(update.view);
		}
		// Handle on-demand trigger
		for (const tr of update.transactions) {
			for (const e of tr.effects) {
				if (e.is(triggerComplete)) {
					forceComplete(update.view);
				}
			}
		}
	});

	return [ghostField, fetchingField, buildIndicatorGutter(plugin), ghostKeymap, listener];
}
