# Spec 07 — SidekickView Decomposition + customAgents Restoration

**Priority:** P1 (High effort, High impact — reduces merge-conflict surface, unblocks upstream PRs)
**Files modified:** `src/sidekickView.ts`, `src/view/sessionConfig.ts`, `src/view/configToolbar.ts`,
`src/view/inputArea.ts`, `src/view/chatRenderer.ts`, `src/bots/telegramBot.ts`
**New files:** `src/view/toolsPanel.ts`, `src/view/chatSession.ts`, `src/view/activeNote.ts`,
`src/view/builtinCommands.ts`, `src/view/promptSlash.ts`, `src/view/agentMention.ts`,
`src/view/actionBars.ts`, `src/view/contextTracker.ts`
**Dependencies:** None — standalone refactor. All specs 01–06 remain valid after this work.

---

## Problem

`sidekickView.ts` has grown to **5,268 lines** and is the single largest contributor to
merge-conflict risk with upstream (`vieiraae/obsidian-sidekick`). Every fork feature
(MCP discovery, tools panel, tasks UI, context tracking, agent mention, prompt slash
commands, etc.) was added inline, creating a monolith that:

1. **Blocks upstream contribution** — PRs touching this file are unreviewable.
2. **Causes merge conflicts** — upstream and fork both edit the same region.
3. **Hurts comprehension** — 5K+ lines with 100+ methods in one class.

Additionally, the fork replaced the Copilot SDK's `customAgents` routing with a
flat `systemMessage` approach. This loses SDK-native agent inference/handoff
capabilities without providing an equivalent.

---

## Goals

1. **Reduce `sidekickView.ts` from ~5,268 to ~700 lines** — only class declaration,
   state properties, lifecycle, and skeletal UI remain.
2. **Extract 8 new view modules** using the existing `installXxx()` mixin pattern.
3. **Restore `customAgents`** alongside `systemMessage` (hybrid approach) in both
   `buildSessionConfig()` and `telegramBot.ts`.
4. **Zero behavioral changes** — all features work identically before and after.
5. **Build passes** with no new TypeScript errors after each phase.

---

## Non-Goals

- No new features introduced by this spec.
- No CSS changes — `styles.css` is untouched.
- No changes to `src/types.ts`, `src/copilot.ts`, or `src/mcpProbe.ts`.
- No restructuring of existing view modules (`chatRenderer.ts`, `searchPanel.ts`,
  `sessionSidebar.ts`, `triggersPanel.ts`) — they stay as-is.

---

## Design

### Architecture: Mixin Pattern

The codebase already uses a proven mixin pattern: standalone modules export an
`installXxx(ViewClass)` function that patches methods onto `SidekickView.prototype`.
This avoids subclassing while keeping each file self-contained.

```typescript
// src/view/toolsPanel.ts
export function installToolsPanel(ViewClass: {prototype: unknown}): void {
    const proto = ViewClass.prototype as SidekickView;
    proto.buildToolsPanel = function(parent: HTMLElement): void { /* ... */ };
    proto.renderToolsPanel = function(): void { /* ... */ };
    // ...
}

// src/sidekickView.ts (bottom)
installToolsPanel(SidekickView);
```

Each new module follows this exact pattern. The `SidekickView` class retains all
state properties (DOM refs, config arrays, flags) so mixins can access `this.*`
without import gymnastics.

### customAgents Restoration (Hybrid)

The fork currently injects agent instructions via `systemMessage` only. The hybrid
approach uses **both**:

```typescript
// buildSessionConfig() — after this refactor lives in view/sessionConfig.ts

// Custom agents — preserve SDK routing + inference
const agentPool = selectedAgentName
    ? agents.filter(a => a.name === selectedAgentName)
    : agents;
const customAgents: CustomAgentConfig[] = agentPool.map(a => ({
    name: a.name,
    displayName: a.name,
    description: a.description || undefined,
    prompt: a.instructions,
    tools: a.tools ?? null,
    infer: true,
}));

// System message — global instructions + tool catalog (additive content
// that doesn't belong in any single agent's prompt)
const systemParts: string[] = [];
if (globalInstructions) systemParts.push(globalInstructions);
if (mcpServerNames.length > 0) {
    systemParts.push('Prefer MCP tools over bash/shell...');
    // + tool catalog
}
const systemContent = systemParts.length > 0
    ? systemParts.join('\n\n') : undefined;

return {
    ...baseConfig,
    ...(customAgents.length > 0 ? {customAgents} : {}),
    ...(systemContent ? {systemMessage: {mode: 'append', content: systemContent}} : {}),
};
```

**Key distinction:** Agent-specific instructions stay in `customAgents[].prompt`.
Global instructions, MCP tool catalog, and behavioral hints go in `systemMessage`.
This preserves SDK agent routing while keeping the fork's enhancements.

---

## Phased Implementation

Each phase is a single commit that must build cleanly. Phases are ordered by
risk (lowest first) and independence (no phase depends on a later phase).

### Phase 1 — Extract `toolsPanel.ts` (~610 lines)

**Methods to move (lines 3246–3856):**

| Method | Lines | Purpose |
|--------|-------|---------|
| `buildToolsPanel()` | 3246–3295 | Create tools tab container + header buttons |
| `renderToolsPanel()` | 3296–3300 | Orchestrate panel rendering |
| `renderMcpServersList()` | 3301–3445 | Render server cards with status, test, auth buttons |
| `renderAgentToolMappings()` | 3446–3551 | Show which agents use which tools |
| `handleMcpSessionEvent()` | 3552–3603 | Parse MCP session events → update server status |
| `refreshMcpToolsList()` | 3604–3663 | Direct JSON-RPC probing of MCP servers |
| `discoverToolsViaSdk()` | 3664–3726 | SDK-based tool discovery for proxy servers |
| `scheduleSdkToolDiscovery()` | 3727–3753 | Retry-based SDK discovery on session create |
| `trackDiscoveredTool()` | 3754–3772 | Incremental tool tracking from execution events |
| `scheduleMcpToolDiscovery()` | 3773–3788 | Orchestrate discovery after config load |
| `runAuthRefresh()` | 3789–3856 | Execute auth command + refresh tokens |

**Validation:** `npm run build` passes; tools tab renders; MCP discovery works.

### Phase 2 — Extract `chatSession.ts` (~490 lines)

**Methods to move (lines 4441–4992):**

| Method | Lines | Purpose |
|--------|-------|---------|
| `addSubagentBlock()` | 4441–4467 | Create sub-agent activity UI block |
| `updateSubagentBlock()` | 4468–4495 | Update sub-agent status (completed/failed) |
| `handleSend()` | 4496–4718 | Main send logic — build prompt, ensure session, stream |
| `handleAbort()` | 4719–4736 | Abort in-progress streaming |
| `ensureSession()` | 4737–4785 | Lazy session creation with config |
| `registerSessionEvents()` | 4786–4918 | Wire all SDK session event handlers |
| `unsubscribeEvents()` | 4919–4923 | Clean up event handlers |
| `disconnectSession()` | 4924–4933 | Disconnect current session |
| `disconnectAllSessions()` | 4934–4945 | Disconnect all background sessions |
| `newConversation()` | 4946–4992 | Reset state for new conversation |

**Validation:** `npm run build` passes; send message; abort; new conversation; session
switching all work.

### Phase 3 — Extract `activeNote.ts` (~297 lines)

**Methods to move (lines 1223–1520):**

| Method | Lines | Purpose |
|--------|-------|---------|
| `updateActiveNote()` | 1223–1248 | Track which note is open, update UI |
| `startSelectionPolling()` | 1249–1255 | Start interval for editor selection tracking |
| `pollSelection()` | 1256–1348 | Read current selection, update suggestions |
| `rebuildSuggestions()` | 1349–1393 | Score and sort context suggestions |
| `acceptSuggestion()` | 1394–1420 | Accept suggestion → attach to prompt |
| `dismissSuggestion()` | 1421–1427 | Dismiss a suggestion |
| `toggleCurrentSuggestion()` | 1428–1466 | Toggle first suggestion on/off |
| `renderActiveNoteBar()` | 1467–1519 | Render active note + suggestions bar |
| `updateToolbarLock()` | 1520 | Lock/unlock toolbar during streaming |

**Validation:** `npm run build` passes; active note bar updates; suggestions appear
and can be accepted/dismissed.

### Phase 4 — Extract `builtinCommands.ts` (~301 lines)

**Methods to move (lines 1949–2251):**

| Method | Lines | Purpose |
|--------|-------|---------|
| `executeBuiltinCommand()` | 1949–2013 | Dispatch `/help`, `/agents`, `/models`, etc. |
| `showHelpInfo()` | 2014–2040 | Render help card |
| `showAgentsList()` | 2041–2052 | Render agent list |
| `showModelsList()` | 2053–2064 | Render model list |
| `showReference()` | 2065–2077 | Render referenced note |
| `showTriggerDebug()` | 2078–2128 | Render trigger debug info |
| `showTasksOverview()` | 2129–2251 | Render tasks panel with active/recent tasks |

**Validation:** `npm run build` passes; type `/help`, `/agents`, `/models`, `/tasks`
in chat — all render correctly.

### Phase 5 — Extract `promptSlash.ts` (~140 lines)

**Methods to move (lines 1808–1948):**

| Method | Lines | Purpose |
|--------|-------|---------|
| `handlePromptTrigger()` | 1808–1837 | Detect `/` prefix → show prompt dropdown |
| `showPromptDropdown()` | 1838–1877 | Build dropdown UI |
| `closePromptDropdown()` | 1878–1885 | Tear down dropdown |
| `navigatePromptDropdown()` | 1886–1893 | Arrow key navigation |
| `updatePromptDropdownSelection()` | 1894–1901 | Highlight selected item |
| `selectPromptFromDropdown()` | 1902–1948 | Insert selected prompt template |

**Validation:** `npm run build` passes; type `/` in chat input → dropdown appears;
arrow keys navigate; Enter selects.

### Phase 6 — Extract `agentMention.ts` (~118 lines)

**Methods to move (lines 2252–2370):**

| Method | Lines | Purpose |
|--------|-------|---------|
| `handleAgentMentionTrigger()` | 2252–2290 | Detect `@` prefix → show agent dropdown |
| `showAgentDropdown()` | 2291–2327 | Build agent dropdown UI |
| `closeAgentDropdown()` | 2328–2336 | Tear down dropdown |
| `navigateAgentDropdown()` | 2337–2344 | Arrow key navigation |
| `updateAgentDropdownSelection()` | 2345–2352 | Highlight selected item |
| `selectAgentFromDropdown()` | 2353–2380 | Select agent + update toolbar |

**Validation:** `npm run build` passes; type `@` in chat → agent dropdown; selection
works.

### Phase 7 — Extract `actionBars.ts` (~80 lines)

**Methods to move (lines 1527–1607):**

| Method | Lines | Purpose |
|--------|-------|---------|
| `renderTriggerTestBar()` | 1527–1567 | Show "test trigger" bar when editing trigger |
| `getActiveTrigger()` | 1568–1578 | Find trigger matching active file |
| `renderAgentEditBar()` | 1579–1600 | Show "edit agent" bar when editing agent |
| `getActiveAgent()` | 1601–1607 | Find agent matching active file |

**Validation:** `npm run build` passes; open a `*.trigger.md` / `*.agent.md` file —
action bar appears.

### Phase 8 — Extract `contextTracker.ts` + expand `sessionConfig.ts` (~260 lines)

**Methods to move to `contextTracker.ts` (lines 4993–5021):**

| Method | Lines | Purpose |
|--------|-------|---------|
| `getPromptTokenLimit()` | 4993–5002 | Compute token limit from model info |
| `checkContextUsage()` | 5003–5021 | Show hint when approaching context limit |

**Methods to move to `sessionConfig.ts` (lines 5022–5252):**

| Method | Lines | Purpose |
|--------|-------|---------|
| `buildSessionConfig()` | 5022–5153 | Assemble full session config object |
| `triageRequest()` | 5154–5184 | Auto-select agent based on prompt |
| `getSessionExtras()` | 5185–5214 | Build extras for inline operations |
| `getWorkingDirectory()` | 5215–5220 | Resolve working dir |
| `getAgentsFolder()` | 5221–5224 | Resolve agents folder |
| `getVaultBasePath()` | 5225–5228 | Resolve vault base path |

**customAgents restoration happens here** — `buildSessionConfig()` is updated to
pass both `customAgents` and `systemMessage`.

**Validation:** `npm run build` passes; send a message — session creates with both
`customAgents` and `systemMessage`; agent auto-selection (triage) works.

### Phase 9 — Consolidate file handling into `inputArea.ts` (~191 lines)

**Methods to move (lines 1609–1800):**

| Method | Lines | Purpose |
|--------|-------|---------|
| `handleAttachFile()` | 1609–1648 | OS file picker attachment |
| `handleClipboard()` | 1649–1663 | Paste clipboard text |
| `handleImagePaste()` | 1664–1684 | Save/attach pasted image |
| `handleFileDrop()` | 1685–1771 | Drag-drop files onto input |
| `ensureFolderExists()` | 1772–1788 | Create folder if needed |
| `getImageAttachmentFolder()` | 1789–1798 | Resolve image attachment path |
| `openScopeModal()` | 1799–1807 | Open vault scope modal |

**Validation:** `npm run build` passes; attach file, paste image, drag-drop file,
clipboard paste all work.

---

## customAgents Hybrid — Detailed Design

### What changed from upstream

**Upstream `buildSessionConfig()`:**
```typescript
const customAgents = agentPool.map(a => ({
    name: a.name, displayName: a.name,
    description: a.description || undefined,
    prompt: a.instructions,
    tools: a.tools ?? null,
    infer: true,
}));
return {
    ...config,
    ...(customAgents.length > 0 ? {customAgents} : {}),
    ...(opts.systemContent ? {systemMessage: {mode: 'append', content: opts.systemContent}} : {}),
};
```

**Fork current (no customAgents):**
```typescript
const systemParts: string[] = [];
if (globalInstructions) systemParts.push(globalInstructions);
if (systemContent) systemParts.push(systemContent);         // agent instructions
if (mcpServerNames.length > 0) systemParts.push('Prefer MCP tools...' + toolCatalog);
return {
    ...config,
    ...(finalSystemContent ? {systemMessage: {mode: 'append', content: finalSystemContent}} : {}),
    // NO customAgents
};
```

### Hybrid approach (this spec)

```typescript
// 1. Custom agents — keep SDK routing + inference
const agentPool = selectedAgentName
    ? agents.filter(a => a.name === selectedAgentName)
    : agents;
const customAgents: CustomAgentConfig[] = agentPool.map(a => ({
    name: a.name,
    displayName: a.name,
    description: a.description || undefined,
    prompt: a.instructions,
    tools: a.tools ?? null,
    infer: true,
}));

// 2. System message — global + non-agent content only
//    (agent-specific instructions are in customAgents[].prompt)
const systemParts: string[] = [];
if (globalInstructions) {
    systemParts.push(globalInstructions);
}
if (mcpServerNames.length > 0) {
    systemParts.push(
        'Prefer MCP tools over bash/shell for external API calls. '
        + 'If a tool call fails, report the error — do not retry.'
    );
    // Include discovered tool catalog
    const toolCatalogParts: string[] = [];
    for (const name of mcpServerNames) {
        const status = mcpServerStatus.get(name);
        if (status?.tools?.length) {
            const toolLines = status.tools.map(
                t => `  - ${t.name}: ${t.description}`
            );
            toolCatalogParts.push(
                `MCP server "${name}" tools:\n${toolLines.join('\n')}`
            );
        }
    }
    if (toolCatalogParts.length > 0) {
        systemParts.push(
            'Available MCP tools:\n' + toolCatalogParts.join('\n')
        );
    }
}
if (contextMode === 'suggest') {
    systemParts.push(
        'Use on-demand file/search tools to gather vault context '
        + 'when needed instead of assuming local context is pre-attached.'
    );
}
const finalSystemContent = systemParts.length > 0
    ? systemParts.join('\n\n') : undefined;

// 3. Combine both
return {
    ...baseConfig,
    ...(customAgents.length > 0 ? {customAgents} : {}),
    ...(finalSystemContent
        ? {systemMessage: {mode: 'append', content: finalSystemContent}}
        : {}),
};
```

### telegramBot.ts — Same hybrid

```typescript
// In buildSessionConfigForTelegram():

// Restore customAgents
const agentPool = agent ? [agent] : this.agents;
const customAgents: CustomAgentConfig[] = agentPool.map(a => ({
    name: a.name,
    displayName: a.name,
    description: a.description || undefined,
    prompt: a.instructions,
    tools: a.tools ?? null,
    infer: true,
}));

// System message for global instructions only (not agent-specific)
const systemParts: string[] = [];
if (this.globalInstructions) systemParts.push(this.globalInstructions);
const systemContent = systemParts.length > 0
    ? systemParts.join('\n\n') : undefined;

return {
    ...config,
    ...(customAgents.length > 0 ? {customAgents} : {}),
    ...(systemContent
        ? {systemMessage: {mode: 'append', content: systemContent}}
        : {}),
};
```

---

## Migration Checklist Per Phase

For each phase, follow this procedure:

```
1. Create the new file with the install function
2. Move methods from sidekickView.ts → new file (cut, not copy)
3. Add import + installXxx(SidekickView) call at bottom of sidekickView.ts
4. Ensure all `this.*` references resolve (state lives on the class)
5. Run `npm run build` — fix any TypeScript errors
6. Run `npm run deploy:local` — manual smoke test in Obsidian
7. Commit: "refactor: extract <module> from sidekickView"
```

---

## Validation Matrix

| Feature | Test Action | Expected |
|---------|------------|----------|
| Tools panel | Click tools tab | Servers listed with status indicators |
| MCP discovery | Enable MCP server, reload | Tools appear in "Discovered tools" |
| Auth refresh | Click key icon on Azure server | Token refreshed, status updated |
| Send message | Type + Enter | Response streams, tool calls render |
| Abort | Click stop during streaming | Streaming stops cleanly |
| New conversation | Click + button | Chat cleared, session reset |
| Session switch | Click session in sidebar | Previous session restores |
| Active note | Switch files | Active note bar updates |
| Suggestions | Select text in editor | Selection suggestion appears |
| Trigger test | Open *.trigger.md file | Test bar appears, fire works |
| Agent edit | Open *.agent.md file | Edit bar appears |
| `/help` | Type /help + Enter | Help card renders |
| `/agents` | Type /agents + Enter | Agent list renders |
| `/tasks` | Type /tasks + Enter | Tasks overview renders |
| Slash prompts | Type `/` in input | Prompt dropdown appears |
| `@` mention | Type `@` in input | Agent dropdown appears |
| Context hint | Send many messages | 85% threshold hint appears |
| Agent triage | Send without agent selected | Auto-selects appropriate agent |
| Clipboard paste | Click clipboard icon | Text attached |
| File attach | Click paperclip | File picker opens |
| Image paste | Cmd+V with image | Image saved + attached |
| Drag-drop | Drag file onto input | File attached |
| Scope modal | Click folder icon | Scope modal opens |
| Search panel | Switch to search tab | Search UI renders |
| Triggers panel | Switch to triggers tab | Trigger list renders |
| Telegram bot | Connect in settings | Bot responds with customAgents |
| customAgents | Enable debug, check config | Both customAgents + systemMessage present |

---

## Expected Final File Sizes

| File | Before | After |
|------|--------|-------|
| `src/sidekickView.ts` | 5,268 | ~650–700 |
| `src/view/toolsPanel.ts` | — (new) | ~610 |
| `src/view/chatSession.ts` | — (new) | ~490 |
| `src/view/activeNote.ts` | — (new) | ~297 |
| `src/view/builtinCommands.ts` | — (new) | ~301 |
| `src/view/promptSlash.ts` | — (new) | ~140 |
| `src/view/agentMention.ts` | — (new) | ~118 |
| `src/view/actionBars.ts` | — (new) | ~80 |
| `src/view/contextTracker.ts` | — (new) | ~30 |
| `src/view/sessionConfig.ts` | 209 | ~440 |
| `src/view/chatRenderer.ts` | 630 | ~685 (absorbs subagent blocks) |
| `src/view/inputArea.ts` | 818 | ~930 (absorbs file handling) |
| `src/bots/telegramBot.ts` | 555 | ~570 (restore customAgents) |

**Total view module count:** 6 existing + 8 new = **14 focused modules** + core class.

---

## Dependency Graph

```
Phase 1 (toolsPanel)       ← standalone, no deps
Phase 2 (chatSession)      ← standalone, no deps
Phase 3 (activeNote)       ← standalone, no deps
Phase 4 (builtinCommands)  ← standalone, no deps
Phase 5 (promptSlash)      ← standalone, no deps
Phase 6 (agentMention)     ← standalone, no deps
Phase 7 (actionBars)       ← standalone, no deps
Phase 8 (contextTracker + sessionConfig + customAgents) ← standalone
Phase 9 (inputArea consolidation)  ← standalone

Telegram customAgents fix  ← depends on Phase 8 (uses same hybrid pattern)
```

All phases are **independent** and can be done in any order, though the listed
order minimizes risk (largest/most isolated extractions first).

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| `this.*` references break after extraction | Medium | Each mixin accesses `this` which is the SidekickView instance. State stays on the class. TypeScript catches missing references at build time. |
| Circular imports between view modules | Low | View modules only import types from `sidekickView.ts` (via `import type`). No module imports another module. |
| Method ordering matters in prototype patching | None | The `installXxx()` calls run after class definition. Method order doesn't matter — they're all on the prototype before `onOpen()` runs. |
| customAgents + systemMessage conflict | Low | The Copilot SDK supports both simultaneously. `customAgents` provides agent metadata for routing; `systemMessage` appends to the system prompt. Verified in SDK source. |
| Upstream merges harder after refactor | Low | The refactor *reduces* merge surface. `sidekickView.ts` shrinks to ~700 lines (close to upstream's ~900 lines). New modules are fork-only additions. |

---

## Rollback

Each phase is a single commit. Reverting any phase is a single `git revert`.
No phase changes persistent data formats, settings schema, or session storage.
