# Changelog

All notable changes to the Sidekick plugin are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased - Jin Lee]

### Added

- **Rich handoff support** for agents — matching the VS Code Copilot custom agent spec. Each handoff defines a `label`, target `agent`, optional `prompt` (with YAML block scalar support), `send` (auto-submit), and `model` override. Handoff buttons render as interactive suggestions after an agent's chat response completes.
- **Agent editor modal** (`agentEditorModal.ts`): Visual form-based editor for `.agent.md` files with intelligent suggestions — model dropdown populated from GitHub Copilot, toggleable tool/skill chips, structured handoff card editor with agent autocomplete, and live markdown generation on save.
- **Agent editor access points**: Pencil icon in chat toolbar, "+" button in Tools tab agent section, pencil-on-hover for each agent in Tools tab, and contextual "Edit agent" button when viewing a `.agent.md` file in the editor.
- **`HandoffConfig` type** (`types.ts`): Structured interface for handoff definitions with `label`, `agent`, `prompt`, `send`, and `model` fields.
- **`parseHandoffsBlock()`** in `configLoader.ts`: Dedicated YAML parser for structured handoff blocks supporting both simple string lists and rich object syntax with block scalars.

### Changed

- **Agent sub-agent roster** now filtered by `handoffs` when defined — agents can restrict which other agents they delegate to. Handoff prompts are injected into the delegation context.
- **Tools panel agent list** restructured as clean card layout — name + edit button on top row, description truncated on its own line below, tool tags wrapped underneath. All containers clip overflow properly.
- **Vault index** (`vaultIndex.ts`): Local metadata-based scoring using Obsidian's metadataCache — filename, aliases, tags, headings, links, backlinks, and recency — with no LLM calls
- **Context builder** (`contextBuilder.ts`): Multi-phase context assembly with metadata scoring, graph boost, de-duplication, token budget allocation, and excerpt extraction; specialised methods for chat queries, trigger firing, and ghost-text completions
- **Trigger modal** (`triggerModal.ts`): Guided UI for creating triggers with 10 cron presets, prompt quality validation, glob/cron mode, and icon/agent/model pickers
- **Content diffing in trigger scheduler**: Hash-based change detection with snapshots (200 max, 30-min TTL), glob-to-regex caching, and ReDoS-safe pattern conversion
- **Deploy script** (`deploy-local.sh`): Automated local build, vault path resolution, artifact copy, and optional CLI-based plugin reload
- **Specification docs** (`_specs/`): Six-phase context intelligence roadmap (P1–P6) with dependency graph and design principles
- **Architecture documentation** (`docs/architecture.md`): Module dependency map, entry-point pathways, and sequence diagrams for chat, session, and trigger flows

### Changed

- **Trigger scheduler** now carries `TriggerFireContext` (changed file path + content) and uses 60-second polling with 5-field cron parsing
- **Settings** expanded with `contextMode`, `searchAgent`, `searchMode`, `agentTriage`, `triggerLastFired`, and `reasoningEffort` options
- **Types** extended with `TriggerConfig` interface (cron/glob, agent/model override, icon, enabled state)
- **Sidekick view** integrates vault index, context builder, and trigger scheduler; adds `sessionContextPaths`, context suggestion system, and selection polling
- **Ghost-text** enhanced with context-aware completions using linked-file summaries, 400 ms debounce, minimum line-length checks, and CodeMirror 6 decorations
- **Main plugin** wires up Copilot service, ghost-text extensions, and editor/file context menus during `onload`
- **Copilot service** adds `resolveGhToken()` for GitHub CLI token extraction with platform-specific binary resolution and environment sanitisation
- **README** updated with expanded documentation

## [1.2.1] - 2026-03-13

### Fixed

- Linting issues

### Changed

- Updated README with table of contents, CLI tools, and enhanced bot configuration details

## [1.2.0] - 2026-03-13

### Added

- Telegram bot integration with configuration and message handling

### Changed

- Refactored code for improved modularity
- Updated warning message text for consistency in settings

## [1.1.0] - 2026-03-12

### Added

- Settings tab UI enhancements

### Changed

- Reorganized README sections for clarity and removed redundant preview content

## [1.0.1] - 2026-03-10

### Fixed

- Linting issues and updated dependencies

## [1.0.0] - 2026-03-10

### Added

- EditModal for advanced text editing with AI and shared task definitions
- ESLint configuration with custom rules for UI text formatting

### Fixed

- Placeholder text for consistency and clarity across modals and settings
- Regex for directory traversal validation in file paths
- Manifest description for clarity

### Changed

- UI text to use sentence case for consistency across notices
- Streamlined debug logging and improved type handling
- Stricter TypeScript configuration for better error handling

## [0.6.0] - 2026-03-03

### Changed

- Plugin guidelines fixes
- Updated manifest with detailed description and author information

## [0.5.0] - 2026-03-03

### Added

- Ghost-text autocomplete feature with gutter indicator
- BYOK (Bring Your Own Key) support with enhanced provider configuration
- Apache License 2.0
- Remote connection support for CopilotService

### Changed

- Updated README to clarify desktop requirements
- Improved installation instructions and CLI verification steps

## [0.1.0] - 2026-02-27

### Added

- Initial release
- Sidekick chat view with folder picker and message metadata display
- Collapsible tool call blocks in chat view
- Tool approval modal and settings for tool invocation permissions
- Folder tree modal and attachment handling with absolute paths
- Editor context menu actions for text manipulation
- Active note tracking and display
- Session sidebar with session management
- Prompt management with loading, selection, and dropdown UI
- Trigger management system with cron and file change support
- Error handling for stale session in message sending
