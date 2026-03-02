/** Parsed agent configuration from *.agent.md frontmatter + body. */
export interface AgentConfig {
	name: string;
	description: string;
	model?: string;
	/** List of MCP tool server names to enable. Empty/undefined = all. */
	tools?: string[];
	/** List of skill names to enable. Empty/undefined = all. */
	skills?: string[];
	instructions: string;
	filePath: string;
}

/** Parsed skill information from a skill folder's SKILL.md. */
export interface SkillInfo {
	name: string;
	description: string;
	/** Vault-relative path to the skill folder. */
	folderPath: string;
}

/** A single MCP server entry parsed from mcp.json. */
export interface McpServerEntry {
	name: string;
	config: Record<string, unknown>;
}

/** A message in the Sidekick chat conversation. */
export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant' | 'info';
	content: string;
	timestamp: number;
	attachments?: ChatAttachment[];
}

/** Parsed prompt template from *.prompt.md. */
export interface PromptConfig {
	name: string;
	/** Agent to auto-select when this prompt is used. */
	agent?: string;
	/** Short description shown in the prompt picker dropdown. */
	description?: string;
	/** Content to prepend to the user's message. */
	content: string;
}

/** An attachment added to a chat message. */
export interface ChatAttachment {
	type: 'file' | 'directory' | 'clipboard' | 'image';
	name: string;
	/** Vault-relative path (for files, directories, images) or absolute OS path when `absolutePath` is true. */
	path?: string;
	/** Raw text content (for clipboard). */
	content?: string;
	/** When true, `path` is an absolute OS path (not vault-relative). */
	absolutePath?: boolean;
}

/** A single trigger definition within a trigger file. */
export interface TriggerEntry {
	type: string;
	cron?: string;
	glob?: string;
}

/** Parsed trigger configuration from *.trigger.md. */
export interface TriggerConfig {
	name: string;
	description?: string;
	agent?: string;
	/** Whether the trigger is active. Defaults to true when not set. */
	enabled: boolean;
	triggers: TriggerEntry[];
	/** Prompt content to send when the trigger fires. */
	content: string;
}
