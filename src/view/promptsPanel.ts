import {normalizePath, setIcon, TFile} from 'obsidian';
import type {SidekickView} from '../sidekickView';
import type {PromptConfig} from '../types';
import {getPromptsFolder} from '../settings';
import {EditModal} from '../modals/editModal';

declare module '../sidekickView' {
	interface SidekickView {
		promptsPanelEl: HTMLElement;
		promptsListEl: HTMLElement;
		promptsFilterEl: HTMLInputElement;
		promptsFilter: string;
		buildPromptsPanel(parent: HTMLElement): void;
		renderPromptsList(): void;
		usePrompt(prompt: PromptConfig): void;
	}
}

export function installPromptsPanel(ViewClass: {prototype: unknown}): void {
	const proto = ViewClass.prototype as SidekickView;

	proto.buildPromptsPanel = function(parent: HTMLElement): void {
		const wrapper = parent.createDiv({cls: 'sidekick-prompts-wrapper'});

		// ── Header ─────────────────────────────────────────────
		const header = wrapper.createDiv({cls: 'sidekick-tools-header'});
		header.createDiv({cls: 'sidekick-tools-title', text: 'Prompt templates'});
		const controls = header.createDiv({cls: 'sidekick-tools-controls'});

		// Path hint
		controls.createSpan({
			cls: 'sidekick-tools-path',
			text: `${this.plugin.settings.sidekickFolder}/prompts/`,
		});

		// Edit folder button
		const editBtn = controls.createEl('button', {
			cls: 'clickable-icon sidekick-triggers-ctrl-btn',
			attr: {title: 'Open prompts folder'},
		});
		setIcon(editBtn, 'folder-open');
		editBtn.addEventListener('click', () => {
			const promptsFolder = getPromptsFolder(this.plugin.settings);
			const folder = this.app.vault.getAbstractFileByPath(promptsFolder);
			if (folder) {
				void (this.app as unknown as Record<string, {revealInFolder(f: unknown): void}>).fileManager.revealInFolder(folder);
			} else {
				new EditModal(this.app, promptsFolder, '*.prompt.md', () => {
					void this.loadAllConfigs({silent: true}).then(() => this.renderPromptsList());
				}).open();
			}
		});

		// Refresh
		const refreshBtn = controls.createEl('button', {
			cls: 'clickable-icon sidekick-triggers-ctrl-btn',
			attr: {title: 'Refresh prompts'},
		});
		setIcon(refreshBtn, 'refresh-cw');
		refreshBtn.addEventListener('click', () => {
			void this.loadAllConfigs({silent: true}).then(() => this.renderPromptsList());
		});

		// ── Filter input ───────────────────────────────────────
		const filterRow = wrapper.createDiv({cls: 'sidekick-prompts-filter-row'});
		this.promptsFilterEl = filterRow.createEl('input', {
			cls: 'sidekick-prompts-filter',
			attr: {type: 'text', placeholder: 'Filter prompts…'},
		});
		this.promptsFilter = '';
		this.promptsFilterEl.addEventListener('input', () => {
			this.promptsFilter = this.promptsFilterEl.value.toLowerCase();
			this.renderPromptsList();
		});

		// ── Prompts list ───────────────────────────────────────
		this.promptsListEl = wrapper.createDiv({cls: 'sidekick-prompts-list'});
	};

	proto.renderPromptsList = function(): void {
		this.promptsListEl.empty();

		const filtered = this.prompts.filter(p =>
			!this.promptsFilter ||
			p.name.toLowerCase().includes(this.promptsFilter) ||
			(p.description ?? '').toLowerCase().includes(this.promptsFilter) ||
			p.content.toLowerCase().includes(this.promptsFilter)
		);

		if (filtered.length === 0) {
			const empty = this.promptsListEl.createDiv({cls: 'sidekick-tools-empty'});
			if (this.prompts.length === 0) {
				empty.createSpan({text: 'No prompts configured. '});
				const hint = empty.createEl('span', {cls: 'sidekick-tools-hint'});
				hint.setText(`Add .prompt.md files to ${this.plugin.settings.sidekickFolder}/prompts/`);
			} else {
				empty.createSpan({text: 'No prompts match your filter.'});
			}
			return;
		}

		for (const prompt of filtered) {
			const card = this.promptsListEl.createDiv({cls: 'sidekick-prompt-card'});

			// Click card to open the prompt file
			card.addEventListener('click', (e) => {
				// Don't trigger when clicking the Use button
				if ((e.target as HTMLElement).closest('.sidekick-prompt-card-use')) return;
				const filePath = normalizePath(`${getPromptsFolder(this.plugin.settings)}/${prompt.name}.prompt.md`);
				const file = this.app.vault.getAbstractFileByPath(filePath);
				if (file instanceof TFile) {
					void this.app.workspace.getLeaf(false).openFile(file);
				}
			});
			card.style.cursor = 'pointer';

			// Top row: name + agent badge + use button
			const topRow = card.createDiv({cls: 'sidekick-prompt-card-top'});

			const nameEl = topRow.createDiv({cls: 'sidekick-prompt-card-name'});
			const slashIcon = nameEl.createSpan({cls: 'sidekick-prompt-card-slash'});
			slashIcon.setText('/');
			nameEl.createSpan({text: prompt.name});

			const badges = topRow.createDiv({cls: 'sidekick-prompt-card-badges'});
			if (prompt.agent) {
				const agentBadge = badges.createSpan({cls: 'sidekick-prompt-card-agent'});
				const agentIcon = agentBadge.createSpan();
				setIcon(agentIcon, 'bot');
				agentBadge.createSpan({text: prompt.agent});
			}

			const useBtn = topRow.createEl('button', {
				cls: 'sidekick-prompt-card-use',
				text: 'Use',
				attr: {title: 'Load this prompt into the chat input'},
			});
			useBtn.addEventListener('click', () => this.usePrompt(prompt));

			// Description
			if (prompt.description) {
				card.createDiv({cls: 'sidekick-prompt-card-desc', text: prompt.description});
			}

			// Content preview (truncated)
			const preview = prompt.content.length > 200 ? prompt.content.slice(0, 200) + '…' : prompt.content;
			const contentEl = card.createDiv({cls: 'sidekick-prompt-card-content'});
			contentEl.setText(preview);
		}
	};

	proto.usePrompt = function(prompt: PromptConfig): void {
		// Switch to chat tab
		this.switchTab('chat');

		// Set the prompt as active
		this.activePrompt = prompt;

		// Auto-select agent if specified
		if (prompt.agent) {
			this.selectAgent(prompt.agent);
		}

		// Fill input
		this.inputEl.value = `/${prompt.name} `;
		this.inputEl.setAttribute('title', prompt.content);
		this.inputEl.setCssProps({'--input-height': 'auto'});
		this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
		this.inputEl.focus();
	};
}
