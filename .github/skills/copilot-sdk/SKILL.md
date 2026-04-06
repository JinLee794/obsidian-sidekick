---
name: copilot-sdk
description: "Build, integrate, and maintain applications using the GitHub Copilot SDK (@github/copilot-sdk) for Node.js/TypeScript. Use when: creating Copilot-powered agents, defining custom tools, configuring sessions, setting up authentication, adding hooks, connecting MCP servers, defining custom sub-agents, checking for SDK updates, troubleshooting SDK issues, streaming responses, handling permissions, customizing system prompts, or integrating Copilot agent capabilities into any app."
---

# GitHub Copilot SDK Integration (Node.js / TypeScript)

Embed Copilot's agentic runtime into applications using the `@github/copilot-sdk` package. The SDK wraps the Copilot CLI via JSON-RPC — you define agent behavior, Copilot handles planning, tool invocation, file edits, and more.

> **Status**: Public Preview (v0.2.x). API may change in breaking ways between minor versions.

## When to Use

- Building a Copilot-powered CLI tool, server, or Obsidian plugin feature
- Defining custom tools the agent can call back into your code
- Orchestrating multi-agent workflows with scoped tools and prompts
- Connecting to MCP servers for external tool access
- Customizing the system prompt, permissions, or session hooks
- Checking for SDK version updates or migrating between versions

## Prerequisites

1. **Copilot CLI** installed and authenticated (`copilot --version`)
   - [Installation guide](https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli)
2. **Node.js >= 18.0.0**
3. **GitHub Copilot subscription** (or BYOK — Bring Your Own Key)

## Step 1: Install

```bash
npm install @github/copilot-sdk
```

For TypeScript projects, also install a runner if needed:
```bash
npm install tsx --save-dev
```

## Step 2: Check Current Version & Updates

```bash
# Check installed version
npm list @github/copilot-sdk

# Check latest published version
npm view @github/copilot-sdk version

# Update to latest
npm install @github/copilot-sdk@latest
```

Review the [CHANGELOG](https://github.com/github/copilot-sdk/blob/main/CHANGELOG.md) before upgrading — breaking changes are documented per-version. Key milestones:

| Version | Date | Notable Changes |
|---------|------|-----------------|
| v0.2.1 | 2026-04-03 | Commands + UI elicitation cross-SDK, `getSessionMetadata`, `sessionFs` |
| v0.2.0 | 2026-03-20 | System prompt `customize` mode, OpenTelemetry, blob attachments, custom agent pre-select, `skipPermission`, CJS compat |
| v0.1.32 | 2026-03-07 | v2/v3 protocol backward compat |
| v0.1.31 | 2026-03-07 | Protocol v3, multi-client tool broadcasts |
| v0.1.30 | 2026-03-03 | Override built-in tools, `setModel()` mid-session |

## Step 3: Core Integration Patterns

### 3a. Minimal Client + Session

```typescript
import { CopilotClient, approveAll } from "@github/copilot-sdk";

const client = new CopilotClient();
const session = await client.createSession({
  model: "gpt-4.1",
  onPermissionRequest: approveAll,
});

const response = await session.sendAndWait({ prompt: "What is 2 + 2?" });
console.log(response?.data.content);

await client.stop();
```

Key points:
- `onPermissionRequest` is **required** on every `createSession` and `resumeSession`
- `approveAll` allows all tool calls — use a custom handler in production
- `sendAndWait()` blocks until the session is idle; use `send()` + event listeners for async flows
- Call `client.stop()` to clean up the CLI process

### 3b. Define Custom Tools

Use `defineTool` with Zod schemas for type-safe tool definitions:

```typescript
import { CopilotClient, defineTool, approveAll } from "@github/copilot-sdk";
import { z } from "zod";

const lookupNote = defineTool("lookup_note", {
  description: "Search for a note in the vault by title",
  parameters: z.object({
    query: z.string().describe("Search query for the note title"),
  }),
  handler: async ({ query }) => {
    // Your logic here — return any JSON-serializable value
    return { title: query, content: "..." };
  },
});

const session = await client.createSession({
  model: "gpt-4.1",
  tools: [lookupNote],
  onPermissionRequest: approveAll,
});
```

Tool options:
- `skipPermission: true` — bypass permission prompt for read-only tools
- `overridesBuiltInTool: true` — replace a built-in CLI tool (e.g., `edit_file`)
- Raw JSON Schema is also supported instead of Zod

### 3c. Streaming Responses

```typescript
const session = await client.createSession({
  model: "gpt-4.1",
  streaming: true,
  onPermissionRequest: approveAll,
});

session.on("assistant.message_delta", (event) => {
  process.stdout.write(event.data.deltaContent);
});

session.on("session.idle", () => {
  console.log(); // newline when done
});

await session.sendAndWait({ prompt: "Explain this codebase" });
```

### 3d. Custom Sub-Agents

Define specialized agents with scoped tools. The runtime auto-delegates based on user intent:

```typescript
const session = await client.createSession({
  model: "gpt-4.1",
  customAgents: [
    {
      name: "researcher",
      displayName: "Research Agent",
      description: "Explores codebases and answers questions using read-only tools",
      tools: ["grep", "glob", "view"],
      prompt: "You are a research assistant. Analyze code and answer questions. Do not modify any files.",
    },
    {
      name: "editor",
      displayName: "Editor Agent",
      description: "Makes targeted code changes",
      tools: ["view", "edit", "bash"],
      prompt: "You are a code editor. Make minimal, surgical changes.",
    },
  ],
  agent: "researcher", // Pre-select this agent at start
  onPermissionRequest: approveAll,
});

// Listen for sub-agent lifecycle
session.on("subagent.started", (e) => console.log(`▶ ${e.data.agentDisplayName}`));
session.on("subagent.completed", (e) => console.log(`✅ ${e.data.agentDisplayName}`));
session.on("subagent.failed", (e) => console.error(`❌ ${e.data.error}`));
```

Configuration reference:
| Field | Required | Purpose |
|-------|----------|---------|
| `name` | ✅ | Unique identifier |
| `prompt` | ✅ | System prompt for the agent |
| `description` | | Helps runtime match user intent — be specific |
| `tools` | | Tool allowlist; `null` = all tools |
| `mcpServers` | | Per-agent MCP server configs |
| `infer` | | `false` to prevent auto-selection |

### 3e. Session Hooks

Intercept and customize every stage of the conversation:

```typescript
const session = await client.createSession({
  model: "gpt-4.1",
  hooks: {
    onSessionStart: async (input) => ({
      additionalContext: `Project: my-app, CWD: ${input.cwd}`,
    }),
    onPreToolUse: async (input) => {
      if (input.toolName === "shell") return { permissionDecision: "ask" };
      return { permissionDecision: "allow" };
    },
    onPostToolUse: async (input) => {
      console.log(`Tool ${input.toolName} completed`);
      return null; // null = no changes
    },
    onUserPromptSubmitted: async (input) => {
      return { modifiedPrompt: input.prompt }; // or null
    },
    onErrorOccurred: async (input) => {
      if (input.recoverable) return { errorHandling: "retry", retryCount: 3 };
      return null;
    },
    onSessionEnd: async (input) => {
      console.log(`Session ended: ${input.reason}`);
      return null;
    },
  },
  onPermissionRequest: approveAll,
});
```

Best practices:
- Keep hooks fast — they run inline and delay the conversation
- Return `null` to proceed with defaults
- Use `additionalContext` over `modifiedPrompt` to preserve user intent
- Scope state by `invocation.sessionId`; clean up in `onSessionEnd`

### 3f. Connect MCP Servers

```typescript
const session = await client.createSession({
  model: "gpt-4.1",
  mcpServers: {
    github: {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
    },
    database: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"],
    },
  },
  onPermissionRequest: approveAll,
});
```

### 3g. Customize System Prompt

**Append mode** (default — SDK guardrails preserved):
```typescript
const session = await client.createSession({
  model: "gpt-4.1",
  systemMessage: {
    content: "You are an assistant for our engineering team. Always be concise.",
  },
  onPermissionRequest: approveAll,
});
```

**Customize mode** (surgically edit sections):
```typescript
import { SYSTEM_PROMPT_SECTIONS } from "@github/copilot-sdk";

const session = await client.createSession({
  model: "gpt-4.1",
  systemMessage: {
    mode: "customize",
    sections: {
      tone: { action: "replace", content: "Respond in a warm, professional tone." },
      code_change_rules: { action: "remove" },
      guidelines: { action: "append", content: "\n* Always cite data sources" },
    },
    content: "Focus on vault management and note-taking workflows.",
  },
  onPermissionRequest: approveAll,
});
```

Available section IDs: `identity`, `tone`, `tool_efficiency`, `environment_context`, `code_change_rules`, `guidelines`, `safety`, `tool_instructions`, `custom_instructions`, `last_instructions`.

Actions: `replace`, `remove`, `append`, `prepend`.

## Step 4: Permission Handling (Production)

Never ship `approveAll` in production. Implement a custom handler:

```typescript
import type { PermissionRequest, PermissionRequestResult } from "@github/copilot-sdk";

const session = await client.createSession({
  model: "gpt-4.1",
  onPermissionRequest: (request): PermissionRequestResult => {
    // request.kind: "shell" | "write" | "read" | "mcp" | "custom-tool" | "url" | "memory" | "hook"
    if (request.kind === "shell") return { kind: "denied-interactively-by-user" };
    if (request.kind === "write") return { kind: "denied-interactively-by-user" };
    return { kind: "approved" };
  },
});
```

Result kinds: `"approved"`, `"denied-interactively-by-user"`, `"denied-by-rules"`, `"denied-no-approval-rule-and-could-not-request-from-user"`, `"denied-by-content-exclusion-policy"`.

## Step 5: Authentication

| Method | How |
|--------|-----|
| Signed-in user (default) | `copilot` CLI login; SDK uses stored OAuth creds |
| GitHub token | `new CopilotClient({ githubToken: "ghp_..." })` or env `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` |
| OAuth GitHub App | Pass user tokens from your OAuth app |
| BYOK | Custom provider config — no GitHub auth required |

BYOK example (OpenAI-compatible):
```typescript
const session = await client.createSession({
  model: "gpt-4",
  provider: {
    type: "openai",
    baseUrl: "https://my-api.example.com/v1",
    apiKey: process.env.MY_API_KEY,
  },
  onPermissionRequest: approveAll,
});
```

## Step 6: Observability (OpenTelemetry)

```typescript
const client = new CopilotClient({
  telemetry: {
    otlpEndpoint: "http://localhost:4318",
    sourceName: "my-copilot-app",
    captureContent: true, // capture message content in traces
  },
});
```

Trace context propagates automatically between SDK and CLI.

## Architecture

```
Your Application
       ↓
  SDK Client (CopilotClient)
       ↓ JSON-RPC (stdio or TCP)
  Copilot CLI (server mode)
       ↓
  LLM Provider (GitHub / BYOK)
```

- The SDK manages the CLI process lifecycle automatically
- You can also connect to an external CLI server: `new CopilotClient({ cliUrl: "localhost:4321" })`
- Node.js SDK ships ESM and CJS builds — works with esbuild `format: "cjs"`

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `copilot` not found | Install Copilot CLI and ensure it's in PATH, or set `cliPath` |
| Auth failure | Run `copilot auth login` or provide `githubToken` / env vars |
| Session hangs | Check `onPermissionRequest` is provided and returning decisions |
| Tool not called | Verify tool `description` is clear; agent selects tools by description |
| Breaking changes after update | Check [CHANGELOG](https://github.com/github/copilot-sdk/blob/main/CHANGELOG.md) for migration notes |
| esbuild/CJS issues | SDK ships dual ESM/CJS since v0.2.0 |

## References

- [SDK Repository](https://github.com/github/copilot-sdk)
- [Node.js SDK README](https://github.com/github/copilot-sdk/blob/main/nodejs/README.md)
- [Getting Started Guide](https://github.com/github/copilot-sdk/blob/main/docs/getting-started.md)
- [Features Index](https://github.com/github/copilot-sdk/blob/main/docs/features/index.md)
- [Custom Agents Guide](https://github.com/github/copilot-sdk/blob/main/docs/features/custom-agents.md)
- [Hooks Guide](https://github.com/github/copilot-sdk/blob/main/docs/features/hooks.md)
- [MCP Servers Guide](https://github.com/github/copilot-sdk/blob/main/docs/features/mcp.md)
- [Authentication Docs](https://github.com/github/copilot-sdk/blob/main/docs/auth/index.md)
- [BYOK Docs](https://github.com/github/copilot-sdk/blob/main/docs/auth/byok.md)
- [Troubleshooting](https://github.com/github/copilot-sdk/blob/main/docs/troubleshooting/debugging.md)
- [CHANGELOG](https://github.com/github/copilot-sdk/blob/main/CHANGELOG.md)
- [Cookbook](https://github.com/github/awesome-copilot/blob/main/cookbook/copilot-sdk)
- [Copilot SDK Node.js Instructions](https://github.com/github/awesome-copilot/blob/main/instructions/copilot-sdk-nodejs.instructions.md)
