// Minimal Copilot SDK stubs for testing
export class CopilotClient {}
export class CopilotSession {}
export function approveAll() { return {approved: true}; }
export function defineTool(name: string, config: Record<string, unknown>) { return {name, ...config}; }
