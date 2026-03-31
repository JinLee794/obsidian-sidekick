import {setIcon} from 'obsidian';
import type {SidekickView} from '../sidekickView';
import type {AgentConfig} from '../types';

export function installAgentMention(ViewClass: {prototype: unknown}): void {
	const proto = ViewClass.prototype as SidekickView;

	proto.handleAgentMentionTrigger = function(): void {
		if (this.agents.length === 0) {
			this.closeAgentDropdown();
			return;
		}

		const value = this.inputEl.value;
		const cursorPos = this.inputEl.selectionStart ?? value.length;

		// Find the last '@' before the cursor that is either at the start or preceded by a space
		let atPos = -1;
		for (let i = cursorPos - 1; i >= 0; i--) {
			if (value[i] === '@') {
				if (i === 0 || value[i - 1] === ' ' || value[i - 1] === '\n') {
					atPos = i;
				}
				break;
			}
			// Stop scanning if we hit a space (the @mention must be contiguous)
			if (value[i] === ' ' || value[i] === '\n') break;
		}

		if (atPos === -1) {
			this.closeAgentDropdown();
			return;
		}

		const query = value.slice(atPos + 1, cursorPos).toLowerCase();
		const filtered = this.agents.filter(a => a.name.toLowerCase().includes(query));

		if (filtered.length === 0) {
			this.closeAgentDropdown();
			return;
		}

		this.agentMentionStart = atPos;
		this.showAgentDropdown(filtered);
	};

	proto.showAgentDropdown = function(agents: AgentConfig[]): void {
		this.closeAgentDropdown();
		this.agentDropdown = document.createElement('div');
		this.agentDropdown.addClass('sidekick-prompt-dropdown sidekick-agent-dropdown');
		this.agentDropdownIndex = 0;

		for (let i = 0; i < agents.length; i++) {
			const a = agents[i];
			if (!a) continue;
			const item = this.agentDropdown.createDiv({cls: 'sidekick-prompt-item sidekick-agent-item'});
			if (i === 0) item.addClass('is-selected');
			item.setAttribute('title', a.description || a.instructions.slice(0, 100));

			const iconEl = item.createSpan({cls: 'sidekick-agent-item-icon'});
			setIcon(iconEl, 'bot');
			item.createSpan({cls: 'sidekick-prompt-item-name', text: `@${a.name}`});
			if (a.description) {
				const desc = a.description.length > 50 ? a.description.slice(0, 50) + '…' : a.description;
				item.createSpan({cls: 'sidekick-prompt-item-desc', text: desc});
			}

			item.addEventListener('click', () => {
				this.agentDropdownIndex = i;
				this.selectAgentFromDropdown();
			});
			item.addEventListener('mouseenter', () => {
				this.agentDropdownIndex = i;
				this.updateAgentDropdownSelection();
			});
		}

		const inputArea = this.inputEl.closest('.sidekick-input-area');
		if (inputArea) {
			inputArea.appendChild(this.agentDropdown);
		}
	};

	proto.closeAgentDropdown = function(): void {
		if (this.agentDropdown) {
			this.agentDropdown.remove();
			this.agentDropdown = null;
			this.agentDropdownIndex = -1;
			this.agentMentionStart = -1;
		}
	};

	proto.navigateAgentDropdown = function(direction: number): void {
		if (!this.agentDropdown) return;
		const items = this.agentDropdown.querySelectorAll('.sidekick-agent-item');
		if (items.length === 0) return;
		this.agentDropdownIndex = (this.agentDropdownIndex + direction + items.length) % items.length;
		this.updateAgentDropdownSelection();
	};

	proto.updateAgentDropdownSelection = function(): void {
		if (!this.agentDropdown) return;
		const items = this.agentDropdown.querySelectorAll('.sidekick-agent-item');
		items.forEach((el, i) => {
			el.toggleClass('is-selected', i === this.agentDropdownIndex);
		});
	};

	proto.selectAgentFromDropdown = function(): void {
		if (!this.agentDropdown || this.agentMentionStart === -1) return;

		const value = this.inputEl.value;
		const cursorPos = this.inputEl.selectionStart ?? value.length;
		const query = value.slice(this.agentMentionStart + 1, cursorPos).toLowerCase();
		const filtered = this.agents.filter(a => a.name.toLowerCase().includes(query));
		const selected = filtered[this.agentDropdownIndex];
		if (!selected) {
			this.closeAgentDropdown();
			return;
		}

		// Replace the @query with @agentName + space
		const before = value.slice(0, this.agentMentionStart);
		const after = value.slice(cursorPos);
		const replacement = `@${selected.name} `;
		this.inputEl.value = before + replacement + after;

		// Move cursor to after the replacement
		const newPos = before.length + replacement.length;
		this.inputEl.setSelectionRange(newPos, newPos);
		this.inputEl.focus();
		this.closeAgentDropdown();
	};
}
