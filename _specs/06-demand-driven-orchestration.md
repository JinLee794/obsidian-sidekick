# Spec 06 — Demand-Driven Orchestration

**Priority:** P6 (High effort, High impact)
**Files modified:** `src/sidekickView.ts`, `src/contextBuilder.ts`, `src/types.ts`, `src/settings.ts`
**New files:** none
**Dependencies:** P3 (`VaultIndex`), P4 (`ContextBuilder`)

---

## Problem

Sidekick currently auto-attaches the active note or editor selection to every
message, eagerly reads vault files to build context excerpts before the prompt
is sent, and requires the user to manually switch agents. This creates three
concrete issues:

1. **Excessive local reads.** Every scoped send triggers a 6-phase context
   pipeline (metadata scan → graph boost → budget fit → `cachedRead` per file
   → excerpt extraction → summary build). The user has no control over what
   gets read or injected.

2. **Invisible context injection.** The active note/selection is silently added
   to `currentAttachments` in `handleSend()` (sidekickView.ts L5130–5160).
   Users cannot see, remove, or prevent this attachment before it is sent.

3. **No automatic agent routing.** All agents are passed as `customAgents` with
   `infer: true`, but the user must manually select one. There is no triage
   step that inspects the request and delegates to the right agent.

### How Copilot Chat Does It

| Behaviour | Copilot Chat (VS Code) | Sidekick (current) |
|---|---|---|
| Active file | Shown as a suggested chip; user clicks to include | Auto-attached silently |
| Selection | Shown as a chip; user drags/clicks to attach | Auto-attached silently |
| Vault/workspace context | Agent uses tools on demand (`read_file`, `grep_search`, etc.) | Plugin reads up to 15 files and injects excerpts into prompt |
| Agent routing | Automatic triage → delegates to best participant | User manually selects agent from dropdown |
| Sub-agent delegation | Transparent; orchestrator spawns sub-agents as needed | Prompt-hint only ("You can delegate to…") |

---

## Goals

1. **Suggested, not auto-attached.** Active note and selection appear as
   removable suggestion chips. They are only included when the user explicitly
   accepts them (click, Enter, or drag).
2. **Tool-first context.** Stop eagerly reading vault files pre-send. Instead,
   provide the agent with tools to pull vault context on demand.
3. **Automatic agent triage.** When multiple agents are configured, add an
   optional triage step that routes the request to the best-fit agent based on
   its description, without requiring manual selection.
4. **Preserve opt-in override.** Users who prefer the current eager behaviour
   can re-enable it via a setting.

---

## Design

### A. Suggested Context Chips (replaces auto-attach)

#### Current flow (sidekickView.ts `handleSend`, L5130–5160)

```
1. Clone user attachments
2. IF activeSelection AND not already attached → push selection attachment
3. ELSE IF activeNotePath AND not already attached → push file attachment
4. Send with these attachments
```

#### New flow

```
1. Clone user attachments (only explicitly added items)
2. No auto-attach
3. Send with these attachments only
```

The active note and selection are shown in the **suggestion bar** (existing
`activeNoteBar` element) as dismissible chips. Clicking a chip moves it into
the real `this.attachments` array. Pressing Enter in the input without
clicking the chip does NOT include it.

**UI changes to `renderActiveNoteBar()`:**

- Chip gets a `+` icon button on the left and an `×` dismiss on the right.
- Clicking `+` (or the chip body) calls a new `acceptSuggestion()` method
  that pushes the item into `this.attachments` and re-renders.
- Clicking `×` hides the suggestion until the next `file-open` / selection
  change.
- A subtle visual distinction (dashed border, muted colour) differentiates
  "suggested" from "attached" chips.

**Keyboard shortcut:** `Cmd+Shift+A` (macOS) / `Ctrl+Shift+A` (Windows/Linux)
toggles the current suggestion into the attachment list while focus is in the
input area.

#### Data model change

```typescript
// types.ts — new
interface ContextSuggestion {
  type: 'file' | 'selection';
  path: string;
  name: string;
  /** Selection-specific fields (undefined for file suggestions). */
  content?: string;
  selection?: { startLine: number; startChar: number; endLine: number; endChar: number };
  /** User dismissed this suggestion (hidden until next change). */
  dismissed: boolean;
}
```

`sidekickView.ts` gains:
- `private suggestions: ContextSuggestion[]` — populated by `pollSelection()`
  and `updateActiveNote()`.
- `private acceptSuggestion(index: number)` — moves suggestion into
  `this.attachments` and removes it from `this.suggestions`.
- `private dismissSuggestion(index: number)` — sets `dismissed = true`.

#### Migration / backwards compatibility

A new setting `contextMode: 'suggest' | 'auto'` (default: `'suggest'`)
controls the behaviour. When set to `'auto'`, the current auto-attach logic
is preserved unchanged.

```typescript
// settings.ts
contextMode: 'suggest' | 'auto';  // default: 'suggest'
```

---

### B. Tool-First Context (replaces eager vault reads)

#### Current flow (sidekickView.ts `handleSend`, L5185–5210)

```
IF contextBuilder exists AND scopePaths.length > 0:
  1. VaultIndex.preFilter() — scan all metadata in scope
  2. applyGraphBoost() — read link graph
  3. fitBudget() — select top N
  4. vault.cachedRead() per file — read content
  5. extractRelevantExcerpt() — trim
  6. Prepend summary + excerpts to prompt
```

#### New flow

```
IF contextMode === 'suggest':
  Skip eager context building entirely.
  Rely on the agent's tool calls for vault reads.

IF contextMode === 'auto':
  Preserve current eager pipeline (no change).
```

To make tool-first viable, the agent must have a vault-context tool. Sidekick
already passes `workingDirectory` and scope paths as directory attachments via
`buildSdkAttachments()`. The Copilot SDK agent already has `read_file`,
`grep_search`, `semantic_search` etc. available in its tool set. No new tools
are strictly required.

**Optional enhancement — vault search tool via MCP:**

If the built-in SDK tools are insufficient for vault-specific queries (e.g.
tag-based search, backlink traversal), expose a lightweight MCP tool server
that wraps `VaultIndex`:

```
Tool: vault_search
  Input:  { query: string, scope?: string[], limit?: number }
  Output: { files: [{ path, excerpt, score, reason }] }

Tool: vault_backlinks
  Input:  { path: string }
  Output: { forward: string[], backward: string[] }
```

This is a **follow-on** item, not required for the initial implementation.
The built-in tools are sufficient for most use cases.

#### What stays

- `buildPrompt()` still inlines clipboard content and explicit selection
  attachments (these were user-initiated).
- `buildSdkAttachments()` still sends explicitly attached files/directories.
- `ContextBuilder` is retained for `contextMode: 'auto'` and for trigger
  context (`buildTriggerContext` is unaffected — triggers are not interactive
  and benefit from eager context).

---

### C. Automatic Agent Triage

#### Current flow

1. All agents loaded from `*.agent.md` files → passed as `customAgents`.
2. User selects agent from dropdown or types `@agent-name`.
3. Selected agent's instructions become `systemMessage`.
4. Non-selected agents are available as sub-agents only if the selected
   agent's `tools` array references them by name.

#### New flow — triage step

When **no agent is explicitly selected** (dropdown shows "Auto" / default)
and multiple agents are configured:

1. **Build a triage prompt** from agent name + description pairs.
2. **Ask the model** (lightweight, no tools) which agent best fits the request.
3. **Route** the actual message to that agent's session config.
4. **Show routing** in the UI: "Routed to **{agent}** — {reason}".

```typescript
// New method in sidekickView.ts
private async triageRequest(prompt: string): Promise<string | null> {
  if (this.agents.length <= 1) return null;
  if (this.selectedAgent) return null; // user already chose

  const agentList = this.agents
    .map(a => `- ${a.name}: ${a.description || 'no description'}`)
    .join('\n');

  const triagePrompt =
    `Given these available agents:\n${agentList}\n\n` +
    `Which single agent is the best fit for this request?\n` +
    `Request: "${prompt.slice(0, 200)}"\n\n` +
    `Respond with ONLY the agent name, nothing else. ` +
    `If none is a clear fit, respond "none".`;

  const result = await this.plugin.copilot!.chat({
    prompt: triagePrompt,
    model: this.resolveModelForAgent(undefined, this.selectedModel || undefined),
  });

  const name = result?.trim();
  if (!name || name.toLowerCase() === 'none') return null;
  return this.agents.find(
    a => a.name.toLowerCase() === name.toLowerCase()
  )?.name ?? null;
}
```

**Integration into `handleSend()`:**

```
// After prompt resolution, before ensureSession():
if (settings.agentTriage && !this.selectedAgent && this.agents.length > 1) {
  const routed = await this.triageRequest(sendPrompt);
  if (routed) {
    this.selectAgent(routed);
    this.addInfoMessage(`Routed to **${routed}**`);
  }
}
```

#### Settings

```typescript
// settings.ts
agentTriage: boolean;  // default: true when agents.length > 1
```

#### Triage cache

To avoid a triage LLM call on every message in the same conversation, cache
the triage result per session. Once an agent is routed, subsequent messages in
the same session continue with that agent unless the user explicitly switches.

```typescript
// sidekickView.ts
private triageAgentForSession: string | null = null;

// Reset on newConversation():
this.triageAgentForSession = null;
```

#### Sub-agent delegation improvement

Currently, sub-agent references are injected as a prompt hint. With the
Copilot SDK's `customAgents` + `infer: true`, the SDK can already invoke
sub-agents as tools. The improvement is to ensure **all agents are always
available as sub-agents** regardless of the `tools` field:

```
// Current: only agents listed in tools[] are appended as delegation hints
// New: all agents are passed as customAgents (already the case), AND
//      the selected agent's system message always includes the full
//      sub-agent roster with descriptions
```

This means removing the `tools`-gated filter for sub-agent hints and always
appending the roster. The agent can choose to ignore irrelevant sub-agents.

---

## Settings Summary

| Setting | Type | Default | Description |
|---|---|---|---|
| `contextMode` | `'suggest' \| 'auto'` | `'suggest'` | `suggest`: show chips, user opts in. `auto`: current eager behaviour. |
| `agentTriage` | `boolean` | `true` | Auto-route to best agent when none selected. |

---

## Implementation Plan

### Phase 1 — Suggested context chips (smallest, most visible change)

**Files:** `sidekickView.ts`, `types.ts`, `settings.ts`, `styles.css`

1. Add `ContextSuggestion` type and `contextMode` setting.
2. Refactor `renderActiveNoteBar()` to render suggestion chips with `+` / `×` buttons.
3. Add `acceptSuggestion()` and `dismissSuggestion()` methods.
4. Guard the auto-attach block in `handleSend()` with `if (contextMode === 'auto')`.
5. Add keyboard shortcut `Cmd+Shift+A` to accept current suggestion.

**Estimated scope:** ~120 lines changed, ~60 lines new.

### Phase 2 — Tool-first context (remove eager reads)

**Files:** `sidekickView.ts`, `contextBuilder.ts`

1. Guard the eager `buildContext()` call in `handleSend()` with `contextMode === 'auto'`.
2. Verify that the Copilot SDK tools (`read_file`, `grep_search`, etc.) can
   access vault files via `workingDirectory`. If not, adjust path resolution.
3. (Optional) Add system message hint: "Use your file search and read tools
   to find relevant vault notes when needed."

**Estimated scope:** ~20 lines changed (mostly guards + 1 system message line).

### Phase 3 — Automatic agent triage

**Files:** `sidekickView.ts`, `settings.ts`

1. Add `agentTriage` setting.
2. Implement `triageRequest()` method.
3. Integrate triage call into `handleSend()` before `ensureSession()`.
4. Add triage cache per session.
5. Update sub-agent delegation to always include full roster.

**Estimated scope:** ~80 lines new, ~30 lines changed.

### Phase 4 — (Follow-on) Vault MCP tool server

**Files:** new `src/vaultMcp.ts`

1. Expose `vault_search` and `vault_backlinks` as an in-process MCP server.
2. Register in `buildSessionConfig()` as a local MCP server.
3. This is only needed if the built-in SDK tools prove insufficient for
   vault-specific queries.

**Estimated scope:** ~150 lines new. Defer until Phase 1–3 are validated.

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Agent triage adds latency (extra LLM call) | Medium | Use fast model, cache per session, skip if only 1 agent |
| Users miss that context is no longer auto-included | High | Suggestion chips are prominent; `contextMode` default is `'suggest'` with clear settings description |
| SDK tools can't resolve vault-relative paths | Medium | `workingDirectory` is already set to vault base; test and adjust path handling in Phase 2 |
| Triage picks wrong agent | Low | Show routing in UI; user can override by selecting agent manually |
| Backward compatibility | Low | `contextMode: 'auto'` preserves all current behaviour exactly |

---

## Success Criteria

1. With `contextMode: 'suggest'`, sending a message WITHOUT clicking the
   suggestion chip results in zero vault file reads beyond what the agent
   explicitly requests via tools.
2. With `agentTriage: true` and 3+ agents configured, the correct agent is
   selected automatically for >80% of requests without user intervention.
3. No regression in `contextMode: 'auto'` — existing eager pipeline works
   identically.
4. Ghost text is unaffected (it uses `metadataCache` only, not vault reads).
