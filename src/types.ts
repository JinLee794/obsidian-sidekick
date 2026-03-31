/** Parsed agent configuration from *.agent.md frontmatter + body. */
export interface AgentConfig {
	name: string;
	description: string;
	model?: string;
	/**
	 * List of MCP server names and/or agent names to enable.
	 * Entries matching another agent's name are treated as sub-agent references;
	 * all other entries are treated as MCP server names.
	 * Empty array = no tools, undefined = all.
	 */
	tools?: string[];
	/** List of skill names to enable. Empty/undefined = all. */
	skills?: string[];
	/**
	 * Structured handoff definitions for this agent.
	 * undefined = can delegate to all other agents (no handoff buttons).
	 * Empty array = cannot delegate to any agent.
	 * When defined, handoff buttons appear after the agent's response.
	 */
	handoffs?: HandoffConfig[];
	instructions: string;
	filePath: string;
}

/** Rich handoff configuration matching VS Code Copilot agent spec. */
export interface HandoffConfig {
	/** Display text shown on the handoff button. */
	label: string;
	/** Target agent name to switch to. */
	agent: string;
	/** Prompt text to send to the target agent. */
	prompt?: string;
	/** Whether to auto-submit the prompt (default false). */
	send?: boolean;
	/** Optional model override for the handoff. */
	model?: string;
}

/** Parsed skill information from a skill folder's SKILL.md. */
export interface SkillInfo {
	name: string;
	description: string;
	/** Vault-relative path to the skill folder. */
	folderPath: string;
}

/** Auth refresh configuration for an MCP server. */
export interface McpAuthConfig {
	/** Command to execute (e.g. "az"). */
	command: string;
	/** Arguments for the command. */
	args?: string[];
	/** If set, capture stdout and store as this MCP input variable ID. */
	setInput?: string;
}

/** A single MCP server entry parsed from mcp.json. */
export interface McpServerEntry {
	name: string;
	config: Record<string, unknown>;
	/** Optional auth refresh configuration. */
	auth?: McpAuthConfig;
}

/** A tool discovered from an MCP server via tools.list. */
export interface McpToolInfo {
	/** Tool identifier (e.g., "get_weather"). */
	name: string;
	/** Namespaced name for MCP tools (e.g., "serverName/toolName"). */
	namespacedName?: string;
	/** Description of what the tool does. */
	description: string;
}

/** An input variable definition from the mcp.json "inputs" array. */
export interface McpInputVariable {
	type: string;
	id: string;
	description: string;
	password?: boolean;
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
	type: 'file' | 'directory' | 'clipboard' | 'image' | 'selection';
	name: string;
	/** Vault-relative path (for files, directories, images, selections) or absolute OS path when `absolutePath` is true. */
	path?: string;
	/** Raw text content (for clipboard or selection). */
	content?: string;
	/** When true, `path` is an absolute OS path (not vault-relative). */
	absolutePath?: boolean;
	/** Selection range (1-based line numbers). */
	selection?: {
		startLine: number;
		startChar: number;
		endLine: number;
		endChar: number;
	};
}

/** Suggested context item that can be explicitly accepted into attachments. */
export interface ContextSuggestion {
	type: 'file' | 'selection';
	path: string;
	name: string;
	/** Selection-specific text (undefined for file suggestions). */
	content?: string;
	selection?: {
		startLine: number;
		startChar: number;
		endLine: number;
		endChar: number;
	};
	/** User dismissed this suggestion until the next context change. */
	dismissed: boolean;
}

/** Selection info passed when "Chat with sidekick" is invoked on selected text. */
export interface SelectionInfo {
	filePath?: string;
	fileName: string;
	startLine: number;
	startChar: number;
	endLine: number;
	endChar: number;
}

/** Parsed trigger configuration from *.trigger.md. */
export interface TriggerConfig {
	name: string;
	description?: string;
	agent?: string;
	/** Model ID to use when this trigger fires. Overrides the agent/session default. */
	model?: string;
	/** Whether the trigger is active. Defaults to true when not set. */
	enabled: boolean;
	/** Cron expression for scheduled triggers (5-field: min hour dom month dow). */
	cron?: string;
	/** Glob pattern for file-change triggers. */
	glob?: string;
	/** Lucide icon name shown in session history. Defaults to 'zap'. */
	icon?: string;
	/** Prompt content to send when the trigger fires. */
	content: string;
	/** Vault-relative path to the trigger file. */
	filePath: string;
}
