// Minimal Obsidian stubs for testing
export function normalizePath(p: string) { return p; }
export class TFile { path = ''; }
export class TFolder { children: unknown[] = []; }
export class Notice { constructor(_msg: string) {} }
export class Modal { open() {} close() {} }
export class PluginSettingTab { constructor(..._args: unknown[]) {} }
export class Setting {
	setName() { return this; }
	setDesc() { return this; }
	addToggle() { return this; }
	addDropdown() { return this; }
	addText() { return this; }
}
export function setIcon() {}
export class Component {}
export class ItemView { constructor(..._args: unknown[]) {} }
export class WorkspaceLeaf {}
export class MarkdownView {}
