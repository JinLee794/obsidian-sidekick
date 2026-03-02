# Sidekick

Your AI-powered second brain inside Obsidian. Chat with agents, run tools, fire triggers, and transform text — all without leaving your vault.

Sidekick connects to GitHub Copilot — or your own AI provider — to give you a fully configurable AI assistant panel with agents, skills, MCP tool servers, prompt templates, triggers, and an editor context menu.

> **Desktop only.** Requires either a GitHub Copilot subscription with the Copilot CLI, or a BYOK (Bring Your Own Key) provider such as OpenAI, Anthropic, Ollama, or any OpenAI-compatible endpoint.

---

## Getting started

### 1. Choose your provider

Sidekick supports two modes:

- **GitHub (built-in)** — Uses the GitHub Copilot CLI and your Copilot subscription. See [Setting up the Copilot CLI](#setting-up-the-copilot-cli) below.
- **BYOK (Bring Your Own Key)** — Connect to OpenAI, Microsoft Foundry, Anthropic, Ollama, Microsoft Foundry Local, or any OpenAI-compatible endpoint. See [BYOK providers](#byok-providers) below.

### 2. Install the plugin

Download `main.js`, `styles.css`, and `manifest.json` from the [latest release](https://github.com/vieiraae/obsidian-sidekick/releases/latest) and place them in your vault:

```
<YourVault>/.obsidian/plugins/sidekick/
```

Reload Obsidian. Enable **Sidekick** in **Settings → Community plugins**.

### 3. Configure

Open **Settings → Sidekick** and configure your provider (see sections below). Click **Test** to verify the connection.

### 4. Initialize the Sidekick folder

In the same settings tab, under **Sidekick settings**, set a **Sidekick folder** name (default: `sidekick`) and click **Initialize**. This creates the folder structure with sample files:

```
sidekick/
  agents/        → Agent definitions (*.agent.md)
  skills/        → Skill definitions (subfolder with SKILL.md)
  tools/         → MCP server config (mcp.json)
  prompts/       → Prompt templates (*.prompt.md)
  triggers/      → Automated triggers (*.trigger.md)
```

### 5. Open Sidekick

Click the **brain** icon in the ribbon, or run the **Open Sidekick** command from the command palette.

---

## Setting up the Copilot CLI

If you're using the **GitHub (built-in)** provider, Sidekick requires the GitHub Copilot CLI. If you have [GitHub Copilot in VS Code](https://marketplace.visualstudio.com/items?itemName=GitHub.copilot), the CLI is already installed — you just need to find its path.

**Verify it's working** by running in a terminal:

```bash
copilot --version
```

If the command is not found, locate the binary using the paths below.

**Find the Copilot CLI path:**

| OS | Typical path |
|----|-------------|
| **Windows** | `%LOCALAPPDATA%\Programs\copilot-cli\copilot.exe` or check inside your VS Code extensions folder: `%USERPROFILE%\.vscode\extensions\github.copilot-*\copilot\dist\` |
| **Linux** | `~/.local/bin/copilot` or inside VS Code extensions: `~/.vscode/extensions/github.copilot-*/copilot/dist/` |
| **macOS** | `~/.local/bin/copilot` or inside VS Code extensions: `~/.vscode/extensions/github.copilot-*/copilot/dist/` |

**Log in** (if not already authenticated):

```bash
copilot auth login
```

Follow the browser-based authentication flow. Once logged in, confirm with:

```bash
copilot auth status
```

In **Settings → Sidekick → GitHub Copilot Client**, choose **Local CLI** or **Remote CLI**:

- **Local CLI** — Set the **Path** to the full path of your `copilot` binary (leave blank if it's on your `PATH`). Toggle **Use Logged-in User** or supply a **GitHub Token**.
- **Remote CLI** — Enter the **URL** of an existing CLI server and a **GitHub Token**.

Click **Test** to verify the connection.

---

## BYOK providers

Sidekick supports Bring Your Own Key (BYOK) providers for users who want to use their own API keys instead of (or alongside) GitHub Copilot.

Open **Settings → Sidekick → Models** and select a provider from the dropdown:

| Provider | Type | Description |
|----------|------|-------------|
| **GitHub (built-in)** | — | Uses GitHub Copilot via the CLI (default) |
| **OpenAI** | `openai` | OpenAI API (`https://api.openai.com/v1`) |
| **Microsoft Foundry** | `azure` | Azure OpenAI / Microsoft Foundry endpoint |
| **Anthropic** | `anthropic` | Anthropic API (`https://api.anthropic.com`) |
| **Ollama** | `openai` | Local Ollama server (`http://localhost:11434/v1`) |
| **Microsoft Foundry Local** | `openai` | Local Foundry model server |
| **Other OpenAI-compatible** | `openai` | Any OpenAI-compatible endpoint |

### BYOK settings

When a non-GitHub provider is selected, additional fields appear:

| Field | Description |
|-------|-------------|
| **Base URL** | API endpoint URL (pre-filled with provider defaults) |
| **Model name** | Model ID to use (e.g. `gpt-4o`, `claude-sonnet-4`, `llama3.2`) |
| **API key** | Sent as `x-api-key` header (optional) |
| **Bearer token** | `Authorization` header token (optional) |
| **Wire API** | API format — `Completions` or `Responses` |

Click **Test** next to the Models heading to validate your provider configuration.

The configured model name automatically appears in both the **Inline operations model** dropdown and the **chat view model** dropdown.

> **Note:** Streaming is automatically disabled for the **Microsoft Foundry Local** provider.

---

## The chat panel

The Sidekick panel opens in the right sidebar. It includes:

- **Chat area** — Streaming AI conversation with full Markdown rendering.
- **Input area** — Type your message; press **Enter** to send, **Shift+Enter** for newlines.
- **Config toolbar** — Select agents, models, skills, tools, working directory, and toggle debug info.
- **Session sidebar** — Browse, search, rename, and switch between conversation sessions.

### Toolbar controls

| Control | Description |
|---------|-------------|
| **+** | Start a new conversation |
| **↻** | Reload all configuration files |
| **Agent dropdown** | Select an agent (auto-selects its preferred model, tools, and skills) |
| **Model dropdown** | Select an AI model |
| **Skills** (wand icon) | Toggle individual skills on/off |
| **Tools** (plug icon) | Toggle individual MCP tool servers on/off |
| **Working dir** (drive icon) | Set the working directory for file operations |
| **Debug** (bug icon) | Show tool calls, token usage, and timing metadata |

### Input actions

| Button | Description |
|--------|-------------|
| **Folder** | Select vault scope — limit which files and folders the AI can see |
| **Paperclip** | Attach files from your OS file system |
| **Clipboard** | Paste clipboard text as an attachment |

The **active note** is automatically attached to every message. The working directory follows the active note's parent folder.

---

## Agents

Agents are Markdown files in `sidekick/agents/` with the naming convention `*.agent.md`. Each agent defines a persona, preferred model, and which tools/skills to enable.

### Example: `grammar.agent.md`

```yaml
---
name: Grammar
description: The Grammar Assistant agent helps users improve their writing
tools:
  - github
skills:
  - ascii-art
model: Claude Sonnet 4.5
---

# Grammar Assistant agent Instructions

You are the **Grammar Assistant agent** — your primary task is to help users improve their writing.
```

### Frontmatter fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Display name shown in the agent dropdown |
| `description` | No | Short description of the agent's purpose |
| `model` | No | Preferred model name or ID (auto-selected when agent is chosen) |
| `tools` | No | YAML list of MCP tool server names to enable. Omit or leave empty for all. |
| `skills` | No | YAML list of skill names to enable. Omit or leave empty for all. |

The Markdown body below the frontmatter is the agent's **system instructions** — sent as context with every message.

When you select an agent, its `tools` and `skills` lists filter which servers and skills are active. You can still manually toggle them in the toolbar menus.

---

## Skills

Skills are subfolders inside `sidekick/skills/`, each containing a `SKILL.md` file.

### Example: `sidekick/skills/ascii-art/SKILL.md`

```yaml
---
name: ascii-art
description: Generates stylized ASCII art text using block characters
---

# ASCII Art Generator

This skill generates ASCII art representations of text using block-style Unicode characters.
```

Skills provide domain-specific instructions that extend the agent's capabilities. Toggle them on/off from the **wand** icon in the toolbar.

---

## Tools (MCP servers)

Tool servers are configured in `sidekick/tools/mcp.json`. Sidekick supports both local (stdio) and remote (HTTP/SSE) MCP servers.

### Example: `mcp.json`

```json
{
  "servers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    },
    "workiq": {
      "command": "npx",
      "args": ["-y", "@microsoft/workiq", "mcp"]
    },
    "my-local-tool": {
      "command": "node",
      "args": ["./my-tool/index.js"],
      "env": { "API_KEY": "..." }
    }
  }
}
```

The `github` server connects to GitHub Copilot's built-in MCP endpoint. The `workiq` server runs [Microsoft Work IQ](https://github.com/microsoft/work-iq-mcp) via NPX — it lets you query your Microsoft 365 data (emails, meetings, documents, Teams messages) using natural language. Work IQ requires Node.js 18+ and admin consent on your Microsoft 365 tenant (see the [admin guide](https://github.com/microsoft/work-iq-mcp/blob/main/ADMIN-INSTRUCTIONS.md) for details).

The format also accepts `"mcpServers"` as the top-level key. Toggle individual servers from the **plug** icon in the toolbar.

### Tool approval

In **Settings → Sidekick → Tools approval**, choose:

- **Allow** — Tool calls are auto-approved (default).
- **Ask** — A modal asks for approval before each tool invocation.

---

## Prompt templates

Prompt templates are Markdown files in `sidekick/prompts/` with the naming convention `*.prompt.md`. They provide reusable slash commands.

### Example: `en-to-pt.prompt.md`

```yaml
---
agent: Grammar
---
Translate the provided text from English to Portuguese.
```

### How to use

1. Type `/` in the chat input to open the prompt dropdown.
2. Start typing to filter prompts.
3. Use **Arrow keys** to navigate, **Enter** or **Tab** to select.
4. The prompt's content is prepended to your message. If the prompt specifies an `agent`, that agent is auto-selected.

### Frontmatter fields

| Field | Required | Description |
|-------|----------|-------------|
| `agent` | No | Auto-select this agent when the prompt is used |
| `description` | No | Shown in the prompt dropdown for context |

---

## Triggers

Triggers automate background tasks. They are Markdown files in `sidekick/triggers/` with the naming convention `*.trigger.md`.

### Example: `daily-planner.trigger.md`

```yaml
---
description: Daily planner
agent: Planner
triggers:
  - type: scheduler
    cron: "0 8 * * *"
  - type: onFileChange
    glob: "**/*.md"
enabled: true
---
Help me prepare my day, including asks on me, recommendations for clear actions to prepare, and suggestions on which items to prioritize over others.
```

### Trigger types

| Type | Field | Description |
|------|-------|-------------|
| `scheduler` | `cron` | Cron expression (minute, hour, day-of-month, month, day-of-week). Checked every 60 seconds. |
| `onFileChange` | `glob` | Glob pattern matching vault file paths. Fires when a matching file is created, modified, or renamed. |

### Frontmatter fields

| Field | Required | Description |
|-------|----------|-------------|
| `description` | No | Human-readable name for the trigger |
| `agent` | No | Agent to use when firing (its model and instructions apply) |
| `triggers` | Yes | YAML list of trigger entries (see above) |

Triggers run in **background sessions** — they appear in the session sidebar with a `[trigger]` tag. File-change triggers include the changed file path in the prompt context.

---

## Editor context menu

Select text in any note, right-click, and choose **Sidekick** to access quick actions:

| Action | Description |
|--------|-------------|
| **Fix grammar and spelling** | Corrects errors in the selected text |
| **Summarize** | Creates a concise summary |
| **Elaborate** | Adds more detail and depth |
| **Answer** | Responds to a question in the text |
| **Explain** | Explains in simple, clear terms |
| **Rewrite** | Improves clarity and readability |

The result **replaces the selected text** in-place. These actions use the **Inline operations model** configured in settings.

---

## Ghost-text autocomplete

Enable **ghost-text autocomplete** in **Settings → Sidekick → Sidekick settings** to get inline AI suggestions as you type in any note. Suggestions appear as dimmed text ahead of your cursor — **double-click** to accept.

Autocomplete uses the **Inline operations model** setting. Works with both GitHub Copilot and BYOK providers.

---

## Sessions

Sidekick maintains a session sidebar on the right side of the panel:

- **Click** a session to switch to it (conversation history is restored).
- **Right-click** a session to rename or delete it.
- **Search** sessions using the filter box at the top.
- Sessions with a **green dot** are currently active (streaming or processing).
- Background sessions (from triggers) continue running even when you switch conversations.

Sessions are automatically named using the pattern `<Agent>: <first message>`. Trigger sessions include a `[trigger]` suffix.

---

## Settings reference

Open **Settings → Sidekick** to configure:

### GitHub Copilot Client

| Setting | Default | Description |
|---------|---------|-------------|
| **Type** | Local CLI | `Local CLI` (spawns the binary) or `Remote CLI` (connects to a running server) |
| **Path** | *(empty)* | Path to the Copilot CLI binary. Leave blank if on `PATH`. (Local mode only) |
| **URL** | *(empty)* | URL of an existing CLI server (Remote mode only) |
| **Use Logged-in User** | On | Use the OS-level GitHub login for auth (Local mode only) |
| **GitHub Token** | *(empty)* | Personal access token (`ghp_…`) for manual auth |

### Models

| Setting | Default | Description |
|---------|---------|-------------|
| **Provider** | GitHub (built-in) | AI provider — GitHub, OpenAI, Microsoft Foundry, Anthropic, Ollama, Foundry Local, or Other |
| **Base URL** | *(per provider)* | API endpoint for BYOK providers |
| **Model name** | *(empty)* | Model ID for BYOK providers (e.g. `gpt-4o`, `claude-sonnet-4`) |
| **API key** | *(empty)* | `x-api-key` header value |
| **Bearer token** | *(empty)* | `Authorization` header token |
| **Wire API** | Completions | API format: `Completions` or `Responses` |

### Sidekick settings

| Setting | Default | Description |
|---------|---------|-------------|
| **Inline operations model** | Default (SDK default) | Model used for editor context-menu actions and ghost-text autocomplete |
| **Sidekick folder** | `sidekick` | Vault folder containing agents, skills, tools, prompts, and triggers |
| **Tools approval** | Ask | Whether tool invocations require manual approval |
| **Enable ghost-text autocomplete** | Off | Show inline AI suggestions as you type in the editor |

---

## Folder structure overview

```
<YourVault>/
  sidekick/
    agents/
      grammar.agent.md          # Agent definition
    skills/
      ascii-art/
        SKILL.md                 # Skill definition
    tools/
      mcp.json                   # MCP server configuration
    prompts/
      en-to-pt.prompt.md         # Prompt template
    triggers/
      daily-planner.trigger.md   # Automated trigger
```

---

## Development

- Install dependencies: `npm install`
- Dev build (watch mode): `npm run dev`
- Production build: `npm run build`
- Lint: `npm run lint`
