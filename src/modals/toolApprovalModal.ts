import {App, Modal} from 'obsidian';
import type {PermissionRequest, PermissionRequestResult} from '../copilot';

export class ToolApprovalModal extends Modal {
	private resolved = false;
	private resolve!: (result: PermissionRequestResult) => void;
	private readonly request: PermissionRequest;
	readonly promise: Promise<PermissionRequestResult>;

	constructor(app: App, request: PermissionRequest) {
		super(app);
		this.request = request;
		this.promise = new Promise<PermissionRequestResult>((res) => {
			this.resolve = res;
		});
	}

	onOpen(): void {
		const {contentEl} = this;
		contentEl.empty();
		contentEl.addClass('sidekick-approval-modal');

		contentEl.createEl('h3', {text: 'Tool approval required'});

		const info = contentEl.createDiv({cls: 'sidekick-approval-info'});
		info.createDiv({cls: 'sidekick-approval-row', text: `Kind: ${this.request.kind}`});

		// Show relevant details based on request kind
		const details: Record<string, unknown> = {...this.request};
		delete details.kind;
		delete details.toolCallId;
		if (Object.keys(details).length > 0) {
			const pre = info.createEl('pre', {cls: 'sidekick-approval-details'});
			pre.createEl('code', {text: JSON.stringify(details, null, 2)});
		}

		const btnRow = contentEl.createDiv({cls: 'sidekick-approval-buttons'});

		const allowBtn = btnRow.createEl('button', {cls: 'mod-cta', text: 'Allow'});
		allowBtn.addEventListener('click', () => {
			this.resolved = true;
			this.resolve({kind: 'approve-once'});
			this.close();
		});

		const denyBtn = btnRow.createEl('button', {text: 'Deny'});
		denyBtn.addEventListener('click', () => {
			this.resolved = true;
			this.resolve({kind: 'reject'});
			this.close();
		});
	}

	onClose(): void {
		if (!this.resolved) {
			this.resolve({kind: 'reject'});
		}
	}
}
