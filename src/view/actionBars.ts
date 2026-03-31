import {Notice, setIcon} from 'obsidian';
import type {SidekickView} from '../sidekickView';
import type {AgentConfig, TriggerConfig} from '../types';
import {getAgentsFolder, getTriggersFolder} from '../settings';

export function installActionBars(ViewClass: {prototype: unknown}): void {
	const proto = ViewClass.prototype as SidekickView;

	proto.renderTriggerTestBar = function(): void {
		this.triggerTestBar.empty();
		const trigger = this.getActiveTrigger();
		if (!trigger) {
			this.triggerTestBar.addClass('is-hidden');
			return;
		}

		this.triggerTestBar.removeClass('is-hidden');
		const btn = this.triggerTestBar.createEl('button', {
			cls: 'sidekick-trigger-test-btn',
			attr: {title: `Test trigger: ${trigger.name}`},
		});
		const iconSpan = btn.createSpan({cls: 'sidekick-trigger-test-icon'});
		setIcon(iconSpan, 'play');
		btn.createSpan({text: `Test trigger: ${trigger.name}`});
		btn.addEventListener('click', () => {
			new Notice(`Testing trigger: ${trigger.name}`);
			// Send through the foreground chat so the user sees the response
			if (trigger.agent) {
				this.selectAgent(trigger.agent);
			}
			// Apply trigger-level model override if set
			if (trigger.model && this.models.some(m => m.id === trigger.model)) {
				this.selectedModel = trigger.model;
				this.modelSelect.value = trigger.model;
			}
			// Abort any active stream first, then send
			if (this.isStreaming && this.currentSession) {
				void this.currentSession.abort();
			}
			// Wait a tick for abort to settle, then send
			setTimeout(() => {
				this.inputEl.value = trigger.content;
				this.inputEl.dispatchEvent(new Event('input'));
				void this.handleSend();
			}, 100);
		});
	};

	proto.getActiveTrigger = function(): TriggerConfig | null {
		if (!this.activeNotePath) return null;
		const triggersFolder = getTriggersFolder(this.plugin.settings);
		if (!this.activeNotePath.startsWith(triggersFolder + '/')) return null;
		if (!this.activeNotePath.endsWith('.trigger.md')) return null;
		return this.triggers.find(t => t.filePath === this.activeNotePath) ?? null;
	};

	proto.renderAgentEditBar = function(): void {
		this.agentEditBar.empty();
		const agent = this.getActiveAgent();
		if (!agent) {
			this.agentEditBar.addClass('is-hidden');
			return;
		}

		this.agentEditBar.removeClass('is-hidden');
		const btn = this.agentEditBar.createEl('button', {
			cls: 'sidekick-agent-edit-bar-btn',
			attr: {title: `Edit agent: ${agent.name}`},
		});
		const iconSpan = btn.createSpan({cls: 'sidekick-agent-edit-bar-icon'});
		setIcon(iconSpan, 'pencil');
		btn.createSpan({text: `Edit agent: ${agent.name}`});
		btn.addEventListener('click', () => {
			this.openAgentEditor(agent);
		});
	};

	proto.getActiveAgent = function(): AgentConfig | null {
		if (!this.activeNotePath) return null;
		const agentsFolder = getAgentsFolder(this.plugin.settings);
		if (!this.activeNotePath.startsWith(agentsFolder + '/')) return null;
		if (!this.activeNotePath.endsWith('.agent.md')) return null;
		return this.agents.find(a => a.filePath === this.activeNotePath) ?? null;
	};
}
