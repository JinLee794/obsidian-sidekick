# PR change catalog (vs original baseline)

Generated: 2026-03-19  
Baseline commit: c6220b09cccb9099f1f8919efd2a3b059740e39c  
Baseline subject: feat: initialize Obsidian sample plugin with basic structure and settings

## Summary

- Commits since baseline: 38
- Aggregate diff: 63 files changed, 24472 insertions(+), 206 deletions(-)
- Status breakdown:
- A: 50
- M: 12
- D: 1

## Highest-churn files (by total changed lines)

- src/sidekickView.ts: +5675 / -0 (total 5675)
- styles.css: +2472 / -5 (total 2477)
- docs/architecture.md: +1254 / -0 (total 1254)
- src/editor/editorMenu.ts: +1019 / -0 (total 1019)
- src/settings.ts: +981 / -15 (total 996)
- src/view/sessionSidebar.ts: +856 / -0 (total 856)
- README.md: +748 / -57 (total 805)
- src/view/inputArea.ts: +761 / -0 (total 761)
- package-lock.json: +711 / -31 (total 742)
- src/modals/editModal.ts: +638 / -0 (total 638)
- src/view/searchPanel.ts: +598 / -0 (total 598)
- src/editor/ghostText.ts: +575 / -0 (total 575)
- src/bots/telegramBot.ts: +557 / -0 (total 557)
- src/view/chatRenderer.ts: +549 / -0 (total 549)
- src/triggerModal.ts: +479 / -0 (total 479)

## Commit timeline (oldest to newest)

- 229f42e | 2026-02-25 | refactor: rename plugin to "obsidian-sidekick" and update settings structure
- 9a9b50c | 2026-02-25 | feat: add Sidekick view and related functionalities
- e455206 | 2026-02-25 | feat: enhance Sidekick view with folder picker and message metadata display
- d438a9d | 2026-02-25 | feat: implement collapsible tool call blocks in Sidekick view
- 2c3c68e | 2026-02-25 | feat: add tool approval modal and related settings for tool invocation permissions
- 0ae03f4 | 2026-02-25 | feat: implement folder tree modal and enhance attachment handling with absolute paths
- 62dfae3 | 2026-02-26 | feat: add editor context menu actions for text manipulation and processing indicators in Sidekick view
- 749a5ee | 2026-02-26 | feat: refactor folder structure handling in settings and sidekick view
- e67901f | 2026-02-26 | feat: add active note tracking and display in Sidekick view
- d03fb41 | 2026-02-26 | feat: add session sidebar with session management features and styles
- 1cc2b69 | 2026-02-26 | feat: implement prompt management with loading, selection, and dropdown UI
- 460868b | 2026-02-26 | feat: add trigger management system with cron and file change support
- dee5f60 | 2026-02-27 | feat: add error handling for stale session in Sidekick view message sending
- 744e772 | 2026-02-27 | Release 0.1.0
- 821ccec | 2026-02-27 | feat: update README for improved installation instructions and CLI verification steps
- 6b4dd8c | 2026-03-02 | feat: add ghost-text autocomplete feature with gutter indicator
- d992541 | 2026-03-02 | feat: enhance CopilotService to support remote connections and update settings interface
- 1fb33d8 | 2026-03-02 | feat: update README and settings for BYOK support, enhance provider configuration, and version bump to 0.5.0
- 033455f | 2026-03-03 | feat: add Apache License 2.0 to the project
- e039eb7 | 2026-03-03 | feat: update README to clarify desktop requirements and change manifest to support non-desktop environments
- 21c7ab1 | 2026-03-03 | feat: update manifest with detailed description and author information
- cd9eff5 | 2026-03-03 | v0.6.0 — plugin guidelines fixes
- 6dd04a4 | 2026-03-03 | fix: update description in manifest for clarity
- b59781d | 2026-03-03 | feat: enhance ESLint configuration and add custom rules for UI text formatting fix: update package versions and dependencies for improved compatibility refactor: streamline debug logging and improve type handling in various modules chore: update TypeScript configuration for stricter type checks and better error handling
- 953d6cb | 2026-03-03 | fix: improve regex for directory traversal validation in file paths
- 5404594 | 2026-03-03 | feat: update UI text to use sentence case and improve consistency across notices
- dc74927 | 2026-03-03 | fix: update placeholder text for consistency and clarity across modals and settings
- 6b635a9 | 2026-03-10 | feat: add EditModal for advanced text editing with AI and shared task definitions
- 47f5a0a | 2026-03-10 | chore: bump version to 1.0.1, fix linting issues and update dependencies
- e87efba | 2026-03-10 | fix: reorganize README sections for clarity and remove redundant preview content
- 5adb1ca | 2026-03-12 | feat: bump version to 1.1.0 and add settings tab UI enhancements
- a3038e4 | 2026-03-12 | fix: update warning message text for consistency in Sidekick settings
- f850311 | 2026-03-13 | Refactor the code to make it more modular
- ae205bd | 2026-03-13 | feat: add Telegram bot integration with configuration and message handling
- 3fd3a0e | 2026-03-13 | docs: update README with TOC, CLI tools and enhanced bot configuration details
- 3ee3baf | 2026-03-13 | feat: bump version to 1.2.1 with fix on linting issues
- d1cb329 | 2026-03-17 | feat: Enhance trigger scheduler with content diffing and vault indexing
- e90beaa | 2026-03-19 | feat: update deployment script and improve build process

## Full changed file inventory

- A: .github/skills/obsidian-cli/SKILL.md
- M: .gitignore
- M: AGENTS.md
- A: CHANGELOG.md
- D: LICENSE
- A: LICENSE.md
- M: README.md
- A: _specs/01-smart-ghost-truncation.md
- A: _specs/02-search-result-cache.md
- A: _specs/03-metadata-prefilter.md
- A: _specs/04-context-builder.md
- A: _specs/05-trigger-diff-context.md
- A: _specs/06-demand-driven-orchestration.md
- A: _specs/README.md
- A: _test_glob.mjs
- A: deploy-local.mjs
- A: deploy-local.sh
- A: docs/architecture.md
- A: docs/images/banner.png
- A: docs/images/bottom-banner.png
- A: docs/images/logo.png
- A: docs/images/screenshot.png
- M: esbuild.config.mjs
- M: eslint.config.mts
- A: image/README/1773508971531.png
- M: manifest.json
- M: package-lock.json
- M: package.json
- A: src/bots/index.ts
- A: src/bots/telegramApi.ts
- A: src/bots/telegramBot.ts
- A: src/bots/types.ts
- A: src/configLoader.ts
- A: src/contextBuilder.ts
- A: src/copilot.ts
- A: src/debug.ts
- A: src/editor/editorMenu.ts
- A: src/editor/ghostText.ts
- M: src/main.ts
- A: src/modals/editModal.ts
- A: src/modals/folderTreeModal.ts
- A: src/modals/index.ts
- A: src/modals/toolApprovalModal.ts
- A: src/modals/userInputModal.ts
- A: src/modals/vaultScopeModal.ts
- M: src/settings.ts
- A: src/sidekickView.ts
- A: src/tasks.ts
- A: src/triggerModal.ts
- A: src/triggerScheduler.ts
- A: src/types.ts
- A: src/vaultIndex.ts
- A: src/view/chatRenderer.ts
- A: src/view/configToolbar.ts
- A: src/view/inputArea.ts
- A: src/view/searchPanel.ts
- A: src/view/sessionConfig.ts
- A: src/view/sessionSidebar.ts
- A: src/view/triggersPanel.ts
- A: src/view/types.ts
- A: src/view/utils.ts
- M: styles.css
- M: versions.json

## Suggested PR segmentation

- Core Sidekick architecture and main UI surface
- Settings and provider/BYOK configuration changes
- Trigger scheduler and context intelligence work
- Editor productivity features (ghost text, context menu, edit modal)
- Telegram bot integration
- Tooling/docs/release metadata and deployment scripts

## Regeneration commands

```powershell
$base='c6220b09cccb9099f1f8919efd2a3b059740e39c'
git rev-list --count "$base..HEAD"
git diff --shortstat "$base..HEAD"
git diff --name-status --find-renames "$base..HEAD"
git log --reverse --pretty=format:'%h|%ad|%s' --date=short "$base..HEAD"
```
