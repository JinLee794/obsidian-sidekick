import type {SidekickView} from '../sidekickView';

export function installPromptSlash(ViewClass: {prototype: unknown}): void {
	const proto = ViewClass.prototype as SidekickView;

	proto.handlePromptTrigger = function(): void {
		const value = this.inputEl.value;
		// Trigger only when text starts with "/" (no space before the slash)
		if (!value.startsWith('/') || value.includes(' ')) {
			this.closePromptDropdown();
			// Clear tooltip if input no longer matches the active prompt
			if (this.activePrompt && !value.startsWith(`/${this.activePrompt.name}`)) {
				this.activePrompt = null;
				this.inputEl.removeAttribute('title');
			}
			return;
		}
		const query = value.slice(1).toLowerCase();

		// Merge built-in commands with user-defined prompts
		const ViewClass = this.constructor as typeof import('../sidekickView').SidekickView;
		const builtinMatches = ViewClass.BUILTIN_COMMANDS
			.filter(c => c.name.toLowerCase().includes(query))
			.map(c => ({name: c.name, description: c.description, content: '', isBuiltin: true as const}));
		const promptMatches = this.prompts
			.filter(p => p.name.toLowerCase().includes(query))
			.map(p => ({...p, isBuiltin: false as const}));
		const combined = [...builtinMatches, ...promptMatches];

		if (combined.length === 0) {
			this.closePromptDropdown();
			return;
		}
		this.showPromptDropdown(combined);
	};

	proto.showPromptDropdown = function(items: Array<{name: string; description?: string; content: string; agent?: string; isBuiltin: boolean}>): void {
		this.closePromptDropdown();
		this.promptDropdown = document.createElement('div');
		this.promptDropdown.addClass('sidekick-prompt-dropdown');
		this.promptDropdownIndex = 0;

		for (let i = 0; i < items.length; i++) {
			const p = items[i];
			if (!p) continue;
			const item = this.promptDropdown.createDiv({cls: 'sidekick-prompt-item' + (p.isBuiltin ? ' sidekick-prompt-builtin' : '')});
			if (i === 0) item.addClass('is-selected');
			item.setAttribute('title', p.isBuiltin ? p.description ?? '' : p.content);

			item.createSpan({cls: 'sidekick-prompt-item-name', text: `/${p.name}`});
			const descText = p.description || (p.content.length > 60 ? p.content.slice(0, 60) + '…' : p.content);
			item.createSpan({cls: 'sidekick-prompt-item-desc', text: descText});
			if (!p.isBuiltin && p.agent) {
				item.createSpan({cls: 'sidekick-prompt-item-agent', text: p.agent});
			}
			if (p.isBuiltin) {
				item.createSpan({cls: 'sidekick-prompt-item-badge', text: 'built-in'});
			}

			item.addEventListener('click', () => {
				this.promptDropdownIndex = i;
				this.selectPromptFromDropdown();
			});
			item.addEventListener('mouseenter', () => {
				this.promptDropdownIndex = i;
				this.updatePromptDropdownSelection();
			});
		}

		// Position above the input area
		const inputArea = this.inputEl.closest('.sidekick-input-area');
		if (inputArea) {
			inputArea.appendChild(this.promptDropdown);
		}
	};

	proto.closePromptDropdown = function(): void {
		if (this.promptDropdown) {
			this.promptDropdown.remove();
			this.promptDropdown = null;
			this.promptDropdownIndex = -1;
		}
	};

	proto.navigatePromptDropdown = function(direction: number): void {
		if (!this.promptDropdown) return;
		const items = this.promptDropdown.querySelectorAll('.sidekick-prompt-item');
		if (items.length === 0) return;
		this.promptDropdownIndex = (this.promptDropdownIndex + direction + items.length) % items.length;
		this.updatePromptDropdownSelection();
	};

	proto.updatePromptDropdownSelection = function(): void {
		if (!this.promptDropdown) return;
		const items = this.promptDropdown.querySelectorAll('.sidekick-prompt-item');
		items.forEach((el, i) => {
			el.toggleClass('is-selected', i === this.promptDropdownIndex);
		});
	};

	proto.selectPromptFromDropdown = function(): void {
		if (!this.promptDropdown) return;
		const value = this.inputEl.value;
		const query = value.startsWith('/') ? value.slice(1).toLowerCase() : '';

		// Build merged list matching handlePromptTrigger
		const ViewClass = this.constructor as typeof import('../sidekickView').SidekickView;
		const builtinMatches = ViewClass.BUILTIN_COMMANDS
			.filter(c => c.name.toLowerCase().includes(query))
			.map(c => ({name: c.name, description: c.description, content: '', isBuiltin: true as const}));
		const promptMatches = this.prompts
			.filter(p => p.name.toLowerCase().includes(query))
			.map(p => ({...p, isBuiltin: false as const}));
		const combined = [...builtinMatches, ...promptMatches];

		const selected = combined[this.promptDropdownIndex];
		if (!selected) {
			this.closePromptDropdown();
			return;
		}

		// Built-in commands execute immediately
		if (selected.isBuiltin) {
			this.closePromptDropdown();
			this.inputEl.value = '';
			this.inputEl.setCssProps({'--input-height': 'auto'});
			this.executeBuiltinCommand(selected.name);
			return;
		}

		this.activePrompt = selected;

		// Auto-select the prompt's agent
		if (selected.agent) {
			this.selectAgent(selected.agent);
		}

		// Replace input with /prompt-name + space
		this.inputEl.value = `/${selected.name} `;
		this.inputEl.setAttribute('title', selected.content);
		this.inputEl.setCssProps({'--input-height': 'auto'});
		this.inputEl.setCssProps({'--input-height': Math.min(this.inputEl.scrollHeight, 200) + 'px'});
		this.inputEl.focus();
		this.closePromptDropdown();
	};
}
