import type {CopilotSession} from '../copilot';
import type {BackgroundSession} from './types';
import {debugTrace} from '../debug';

/**
 * Callbacks for host-specific behavior during background session events.
 * The shared event wiring handles all state mutation on BackgroundSession;
 * the host only needs to supply UI/discovery side-effects.
 */
export interface BgEventCallbacks {
	/** Called when session becomes idle or errors — host should re-render sidebar. */
	onSessionFinished: () => void;
	/** Called on tool.execution_start with MCP server name (if any) + tool name. */
	onToolDiscovered?: (mcpServer: string, toolName: string) => void;
	/** Called on session.info / session.warning. */
	onSessionEvent?: (type: string, message: string, level: 'info' | 'warning') => void;
	/** Called to safely remove a streaming Component from the Obsidian component tree. */
	removeChild?: (component: unknown) => void;
}

/**
 * Register event handlers that route SDK session events into a BackgroundSession
 * object. This is the single source of truth for background event wiring —
 * used by both sidekickView and sessionSidebar.
 */
export function registerBackgroundEvents(
	session: CopilotSession,
	bg: BackgroundSession,
	callbacks: BgEventCallbacks,
): void {
	bg.unsubscribers.push(
		session.on('assistant.turn_start', () => {
			if (bg.turnStartTime === 0) bg.turnStartTime = Date.now();
		}),
		session.on('assistant.message_delta', (event) => {
			bg.streamingContent += event.data.deltaContent;
		}),
		session.on('assistant.message', () => { /* accumulated via deltas */ }),
		session.on('assistant.usage', (event) => {
			const d = event.data;
			if (!bg.turnUsage) {
				bg.turnUsage = {
					inputTokens: d.inputTokens ?? 0,
					outputTokens: d.outputTokens ?? 0,
					cacheReadTokens: d.cacheReadTokens ?? 0,
					cacheWriteTokens: d.cacheWriteTokens ?? 0,
					model: d.model,
				};
			} else {
				bg.turnUsage.inputTokens += d.inputTokens ?? 0;
				bg.turnUsage.outputTokens += d.outputTokens ?? 0;
				bg.turnUsage.cacheReadTokens += d.cacheReadTokens ?? 0;
				bg.turnUsage.cacheWriteTokens += d.cacheWriteTokens ?? 0;
				if (d.model) bg.turnUsage.model = d.model;
			}
		}),
		session.on('session.idle', () => {
			if (bg.streamingContent) {
				bg.messages.push({
					id: `a-${Date.now()}`,
					role: 'assistant',
					content: bg.streamingContent,
					timestamp: Date.now(),
				});
			}
			bg.streamingContent = '';
			bg.streamingBodyEl = null;
			bg.streamingWrapperEl = null;
			bg.toolCallsContainer = null;
			bg.activeToolCalls.clear();
			if (bg.streamingComponent && callbacks.removeChild) {
				try { callbacks.removeChild(bg.streamingComponent); } catch { /* ignore */ }
			}
			bg.streamingComponent = null;
			bg.turnStartTime = 0;
			bg.turnToolsUsed = [];
			bg.turnSkillsUsed = [];
			bg.turnUsage = null;
			bg.isStreaming = false;
			callbacks.onSessionFinished();
		}),
		session.on('session.error', (event) => {
			bg.messages.push({
				id: `i-${Date.now()}`,
				role: 'info',
				content: `Error: ${event.data.message}`,
				timestamp: Date.now(),
			});
			bg.isStreaming = false;
			bg.streamingContent = '';
			bg.streamingBodyEl = null;
			bg.streamingWrapperEl = null;
			bg.toolCallsContainer = null;
			bg.activeToolCalls.clear();
			if (bg.streamingComponent && callbacks.removeChild) {
				try { callbacks.removeChild(bg.streamingComponent); } catch { /* ignore */ }
			}
			bg.streamingComponent = null;
			callbacks.onSessionFinished();
		}),
		session.on('tool.execution_start', (event) => {
			bg.turnToolsUsed.push(event.data.toolName);
			const mcpServer = (event.data as {mcpServerName?: string}).mcpServerName;
			if (mcpServer && callbacks.onToolDiscovered) {
				callbacks.onToolDiscovered(mcpServer, event.data.toolName);
			}
		}),
		session.on('tool.execution_complete', () => {
			// No DOM manipulation — hidden session
		}),
		session.on('skill.invoked', (event) => {
			debugTrace('skill.invoked (bg)', {name: event.data.name});
			bg.turnSkillsUsed.push(event.data.name);
		}),
		session.on('session.info', (event) => {
			if (callbacks.onSessionEvent) {
				callbacks.onSessionEvent(event.data.infoType, event.data.message, 'info');
			}
		}),
		session.on('session.warning', (event) => {
			if (callbacks.onSessionEvent) {
				callbacks.onSessionEvent(event.data.warningType, event.data.message, 'warning');
			}
		}),
	);
}
