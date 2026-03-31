import {MarkdownView, setIcon} from 'obsidian';
import type {SidekickView} from '../sidekickView';
import type {ContextSuggestion} from '../types';

export function installActiveNote(ViewClass: {prototype: unknown}): void {
	const proto = ViewClass.prototype as SidekickView;

	proto.updateActiveNote = function(): void {
		const file = this.app.workspace.getActiveFile();
		this.activeNotePath = file ? file.path : null;
		// Clear selection when switching files — pollSelection will pick up the new one
		this.activeSelection = null;
		this.rebuildSuggestions(true);
		this.renderActiveNoteBar();
		this.renderTriggerTestBar();
		this.renderAgentEditBar();

		// Update working directory to the parent folder of the active note
		if (file) {
			const lastSlash = file.path.lastIndexOf('/');
			const newDir = lastSlash > 0 ? file.path.substring(0, lastSlash) : '';
			if (newDir !== this.workingDir) {
				this.workingDir = newDir;
				this.updateCwdButton();
				this.configDirty = true;
			}
		}
	};

	proto.startSelectionPolling = function(): void {
		const POLL_MS = 300;
		const timerId = window.setInterval(() => this.pollSelection(), POLL_MS);
		this.selectionPollTimer = timerId as unknown as ReturnType<typeof setInterval>;
		this.registerInterval(timerId);
	};

	proto.pollSelection = function(): void {
		// Try to get the active MarkdownView. If focus is in our chat view,
		// fall back to iterating workspace leaves to find the most recent editor.
		let mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
		let editorIsActive = !!mdView;

		if (!mdView && this.containerEl.contains(document.activeElement)) {
			// Focus is in our chat — find the last MarkdownView leaf to read cursor from
			this.editorHadFocus = false;
			this.app.workspace.iterateAllLeaves(leaf => {
				if (!mdView && leaf.view instanceof MarkdownView) {
					mdView = leaf.view;
				}
			});
			editorIsActive = false;
		}

		if (!mdView) {
			this.editorHadFocus = false;
			if (this.activeSelection) {
				this.activeSelection = null;
				this.rebuildSuggestions(true);
				this.renderActiveNoteBar();
			}
			this.cursorPosition = null;
			return;
		}

		const editorFocused = editorIsActive && mdView.containerEl.contains(document.activeElement);
		const editor = mdView.editor;
		const from = editor.getCursor('from');
		const to = editor.getCursor('to');
		const hasSelection = from.line !== to.line || from.ch !== to.ch;

		// Always update cursor position from the editor
		const cursorFile = mdView.file;
		if (cursorFile) {
			this.cursorPosition = {
				filePath: cursorFile.path,
				fileName: cursorFile.name,
				line: from.line + 1,
				ch: from.ch,
			};
		}

		if (!hasSelection) {
			// Editor just regained focus (wasn't focused last tick) — the selection
			// collapsed because of the focus change, not a deliberate user action.
			// Keep the tracked selection intact.
			if (editorFocused && !this.editorHadFocus) {
				this.editorHadFocus = true;
				return;
			}
			// Editor was already focused — user deliberately deselected.
			// Or editor is not focused (cursor read from background leaf) — keep selection if tracked.
			if (!editorIsActive) {
				// Reading from background editor — don't clear selection
				return;
			}
			this.editorHadFocus = editorFocused;
			if (this.activeSelection) {
				this.activeSelection = null;
				this.rebuildSuggestions(true);
				this.renderActiveNoteBar();
			}
			return;
		}
		// Active selection present — cursor position is the selection start (already set above)
		this.editorHadFocus = editorFocused;

		const file = mdView.file;
		if (!file) return;

		const text = editor.getRange(from, to);
		const prev = this.activeSelection;
		// Only re-render if the selection actually changed
		if (prev && prev.filePath === file.path && prev.startLine === from.line + 1 && prev.endLine === to.line + 1 && prev.startChar === from.ch && prev.endChar === to.ch) {
			return;
		}

		this.activeSelection = {
			filePath: file.path,
			fileName: file.name,
			text,
			startLine: from.line + 1,
			startChar: from.ch,
			endLine: to.line + 1,
			endChar: to.ch,
		};
		this.rebuildSuggestions(true);
		this.renderActiveNoteBar();
	};

	proto.rebuildSuggestions = function(resetDismissed: boolean): void {
		const next: ContextSuggestion[] = [];

		if (this.activeSelection) {
			const sel = this.activeSelection;
			const name = sel.startLine === sel.endLine
				? `${sel.fileName}:${sel.startLine}`
				: `${sel.fileName}:${sel.startLine}-${sel.endLine}`;
			next.push({
				type: 'selection',
				path: sel.filePath,
				name,
				content: sel.text,
				selection: {
					startLine: sel.startLine,
					startChar: sel.startChar,
					endLine: sel.endLine,
					endChar: sel.endChar,
				},
				dismissed: false,
			});
		} else if (this.activeNotePath) {
			const name = this.activeNotePath.split('/').pop() || this.activeNotePath;
			next.push({
				type: 'file',
				path: this.activeNotePath,
				name,
				dismissed: false,
			});
		}

		if (!resetDismissed) {
			for (const suggestion of next) {
				const existing = this.suggestions.find(s =>
					s.type === suggestion.type &&
					s.path === suggestion.path &&
					s.name === suggestion.name
				);
				if (existing?.dismissed) suggestion.dismissed = true;
			}
		}

		this.suggestions = next;
	};

	proto.acceptSuggestion = function(index: number): void {
		const suggestion = this.suggestions[index];
		if (!suggestion) return;

		if (suggestion.type === 'selection') {
			const range = suggestion.selection;
			if (!range) return;
			this.attachments.push({
				type: 'selection',
				name: suggestion.name,
				path: suggestion.path,
				content: suggestion.content,
				selection: {...range},
			});
		} else {
			this.attachments.push({
				type: 'file',
				name: suggestion.name,
				path: suggestion.path,
			});
		}

		this.suggestions.splice(index, 1);
		this.renderAttachments();
		this.renderActiveNoteBar();
	};

	proto.dismissSuggestion = function(index: number): void {
		const suggestion = this.suggestions[index];
		if (!suggestion) return;
		suggestion.dismissed = true;
		this.renderActiveNoteBar();
	};

	proto.toggleCurrentSuggestion = function(): void {
		const idx = this.suggestions.findIndex(s => !s.dismissed);
		if (idx >= 0) {
			this.acceptSuggestion(idx);
			return;
		}

		if (this.activeSelection) {
			const sel = this.activeSelection;
			const attIdx = this.attachments.findIndex(a =>
				a.type === 'selection' &&
				a.path === sel.filePath &&
				a.selection?.startLine === sel.startLine &&
				a.selection?.endLine === sel.endLine &&
				a.selection?.startChar === sel.startChar &&
				a.selection?.endChar === sel.endChar
			);
			if (attIdx >= 0) {
				this.attachments.splice(attIdx, 1);
				this.renderAttachments();
				this.rebuildSuggestions(false);
				this.renderActiveNoteBar();
			}
			return;
		}

		if (this.activeNotePath) {
			const attIdx = this.attachments.findIndex(a =>
				a.type === 'file' && a.path === this.activeNotePath
			);
			if (attIdx >= 0) {
				this.attachments.splice(attIdx, 1);
				this.renderAttachments();
				this.rebuildSuggestions(false);
				this.renderActiveNoteBar();
			}
		}
	};

	proto.renderActiveNoteBar = function(): void {
		this.activeNoteBar.empty();
		if (this.suggestions.length === 0) {
			this.activeNoteBar.addClass('is-hidden');
			return;
		}

		this.activeNoteBar.removeClass('is-hidden');
		this.activeNoteBar.createSpan({
			cls: 'sidekick-suggestions-label',
			text: 'Suggested context',
		});

		for (let i = 0; i < this.suggestions.length; i++) {
			const suggestion = this.suggestions[i];
			if (!suggestion || suggestion.dismissed) continue;

			if (this.attachments.some(a => a.type === suggestion.type && a.path === suggestion.path)) {
				continue;
			}

			const tag = this.activeNoteBar.createDiv({cls: 'sidekick-attachment-tag sidekick-active-note-tag sidekick-suggestion-tag'});
			const addBtn = tag.createSpan({cls: 'sidekick-suggestion-accept', attr: {title: 'Attach context'}});
			setIcon(addBtn, 'plus');
			addBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.acceptSuggestion(i);
			});

			const body = tag.createSpan({cls: 'sidekick-suggestion-body'});
			const ic = body.createSpan({cls: 'sidekick-attachment-icon'});
			setIcon(ic, suggestion.type === 'selection' ? 'text-cursor-input' : 'file-text');
			body.createSpan({text: suggestion.name, cls: 'sidekick-attachment-name'});
			body.addEventListener('click', () => this.acceptSuggestion(i));

			const removeBtn = tag.createSpan({cls: 'sidekick-suggestion-dismiss', attr: {title: 'Dismiss suggestion'}});
			setIcon(removeBtn, 'x');
			removeBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				this.dismissSuggestion(i);
			});

			tag.setAttribute('title', suggestion.type === 'selection'
				? `Suggested selection from ${suggestion.path}`
				: `Suggested active note: ${suggestion.path}`);
		}

		if (this.activeNoteBar.children.length <= 1) {
			this.activeNoteBar.addClass('is-hidden');
		}
	};

	proto.updateToolbarLock = function(): void {
		// No-op — reserved for future toolbar locking behavior.
	};
}
