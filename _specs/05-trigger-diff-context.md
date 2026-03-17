# Spec 05 — Trigger Diff Context

**Priority:** P5 (Medium effort, Medium impact)
**Files modified:** `src/triggerScheduler.ts`, `src/sidekickView.ts`
**New files:** None
**Dependencies:** Standalone (optionally uses `VaultIndex` from P3 for backlinks)

---

## Problem

When a file-change trigger fires, the LLM only receives `[File changed: path]` as a
prefix. It has no idea:

- **What changed** — no diff, no before/after
- **What's in the file** — no content attached
- **What's related** — no backlinks, no scope

### Current Implementation

```
fireTriggerInBackground() — sidekickView.ts line 3605:

  let prompt = trigger.content;
  if (context?.filePath) {
    prompt = `[File changed: ${context.filePath}]\n\n${trigger.content}`;
  }
  await session.send({prompt});  // ← No attachments, no file content, no diff

TriggerFireContext — triggerScheduler.ts line 70:
  interface TriggerFireContext {
    filePath?: string;  // That's it. Just the path.
  }
```

---

## Design

### Enriched Trigger Context

Extend `TriggerFireContext` to carry the changed file's content snapshot:

```typescript
// triggerScheduler.ts

export interface TriggerFireContext {
  filePath?: string;
  /** Content of the file at the time the trigger fired */
  currentContent?: string;
  /** Previous content (if available from snapshot cache) */
  previousContent?: string;
}
```

### Content Snapshot Cache

Maintain a lightweight cache of the last-known content for files matching active
glob triggers. This enables computing diffs when a file changes.

```typescript
// triggerScheduler.ts — new class property

/** path → last-known content hash + content (for diff computation) */
private contentSnapshots = new Map<string, {
  hash: number;
  content: string;
  timestamp: number;
}>();

// Snapshot retention limit
private static readonly MAX_SNAPSHOTS = 200;
private static readonly SNAPSHOT_TTL = 30 * 60 * 1000; // 30 minutes
```

### Snapshot Lifecycle

```typescript
// When a file-change trigger fires:

async checkFileChangeTriggers(
  filePath: string,
  app: App,  // new parameter
): void {
  // ... existing glob matching + cooldown ...

  // Read current file content
  const file = app.vault.getAbstractFileByPath(filePath);
  let currentContent: string | undefined;
  if (file instanceof TFile) {
    currentContent = await app.vault.cachedRead(file);
  }

  // Look up previous snapshot
  const snapshot = this.contentSnapshots.get(filePath);
  const previousContent = snapshot?.content;

  // Update snapshot
  if (currentContent !== undefined) {
    this.updateSnapshot(filePath, currentContent);
  }

  // Fire with enriched context
  this.onTriggerFire(trigger, {
    filePath,
    currentContent,
    previousContent,
  });
}
```

### Snapshot Management

```typescript
private updateSnapshot(filePath: string, content: string): void {
  // Simple string hash for change detection
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
  }

  this.contentSnapshots.set(filePath, {
    hash,
    content,
    timestamp: Date.now(),
  });

  // Evict stale entries
  if (this.contentSnapshots.size > TriggerScheduler.MAX_SNAPSHOTS) {
    this.evictOldSnapshots();
  }
}

private evictOldSnapshots(): void {
  const cutoff = Date.now() - TriggerScheduler.SNAPSHOT_TTL;
  for (const [path, snap] of this.contentSnapshots) {
    if (snap.timestamp < cutoff) {
      this.contentSnapshots.delete(path);
    }
  }

  // If still over limit, evict oldest
  if (this.contentSnapshots.size > TriggerScheduler.MAX_SNAPSHOTS) {
    const sorted = [...this.contentSnapshots.entries()]
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    const excess = sorted.length - TriggerScheduler.MAX_SNAPSHOTS;
    for (let i = 0; i < excess; i++) {
      this.contentSnapshots.delete(sorted[i][0]);
    }
  }
}
```

### Diff Computation

A simple line-level diff (no external dependency) for the prompt:

```typescript
// In sidekickView.ts — fireTriggerInBackground():

function computeSimpleDiff(before: string, after: string): string {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  const added: string[] = [];
  const removed: string[] = [];

  // Simple set-based diff (good enough for trigger context)
  const beforeSet = new Set(beforeLines);
  const afterSet = new Set(afterLines);

  for (const line of afterLines) {
    if (!beforeSet.has(line) && line.trim()) {
      added.push(`+ ${line}`);
    }
  }
  for (const line of beforeLines) {
    if (!afterSet.has(line) && line.trim()) {
      removed.push(`- ${line}`);
    }
  }

  if (added.length === 0 && removed.length === 0) return '';

  const parts: string[] = [];
  if (added.length > 0) parts.push('Added:\n' + added.slice(0, 20).join('\n'));
  if (removed.length > 0) parts.push('Removed:\n' + removed.slice(0, 20).join('\n'));
  return parts.join('\n\n');
}
```

### Enriched Trigger Prompt

```typescript
// In fireTriggerInBackground() — replace the simple path prefix:

let prompt = trigger.content;

if (context?.filePath) {
  const parts: string[] = [];

  // 1. File path
  parts.push(`File changed: ${context.filePath}`);

  // 2. Diff (if previous snapshot available)
  if (context.previousContent && context.currentContent) {
    const diff = computeSimpleDiff(context.previousContent, context.currentContent);
    if (diff) {
      // Truncate diff to avoid blowing up the prompt
      const truncated = diff.length > 1500 ? diff.slice(0, 1500) + '\n...(truncated)' : diff;
      parts.push(`Changes:\n${truncated}`);
    }
  }

  // 3. Current file content excerpt (if no diff or first time)
  if (!context.previousContent && context.currentContent) {
    const excerpt = context.currentContent.length > 2000
      ? context.currentContent.slice(0, 2000) + '\n...(truncated)'
      : context.currentContent;
    parts.push(`Current content:\n${excerpt}`);
  }

  // 4. Related files (if VaultIndex available — optional P3 dependency)
  if (this.vaultIndex) {
    const linked = this.vaultIndex.getLinkedFiles(context.filePath);
    if (linked.backward.length > 0) {
      parts.push(`Referenced by: ${linked.backward.slice(0, 5).join(', ')}`);
    }
    if (linked.forward.length > 0) {
      parts.push(`Links to: ${linked.forward.slice(0, 5).join(', ')}`);
    }
  }

  prompt = `---\n${parts.join('\n\n')}\n---\n\n${trigger.content}`;
}
```

---

## Changes

### `src/triggerScheduler.ts`

| Location | Change |
|----------|--------|
| `TriggerFireContext` interface (line 70) | Add `currentContent?: string`, `previousContent?: string` |
| `TriggerScheduler` class | Add `contentSnapshots` map, `MAX_SNAPSHOTS`, `SNAPSHOT_TTL` |
| `checkFileChangeTriggers()` | Accept `app: App` parameter; read file content; look up previous snapshot; enrich context |
| New private methods | `updateSnapshot()`, `evictOldSnapshots()` |
| `stop()` | Clear `contentSnapshots` |

### `src/sidekickView.ts`

| Location | Change |
|----------|--------|
| `fireTriggerInBackground()` (line 3605) | Replace simple path prefix with enriched prompt (diff + excerpt + links) |
| Vault event handlers | Pass `this.app` to `scheduler.checkFileChangeTriggers()` |
| New private function | `computeSimpleDiff(before, after)` |
| Integration with `vaultIndex` | Conditionally add linked files if `vaultIndex` is available |

---

## Prompt Format Change

### Before

```
[File changed: projects/quarterly-review.md]

Summarize any important changes to project files.
```

### After (with previous snapshot)

```
---
File changed: projects/quarterly-review.md

Changes:
Added:
+ ## Q2 Milestones
+ - Launch beta by June 15
+ - Complete security audit by May 30

Removed:
- ## Pending
- - TBD

Referenced by: meetings/2026-03-10.md, people/alice.md
Links to: projects/budget.md, projects/team.md
---

Summarize any important changes to project files.
```

### After (first time seeing file, no previous snapshot)

```
---
File changed: projects/quarterly-review.md

Current content:
# Quarterly Review
## Q1 Summary
Revenue grew 12% YoY...
...(truncated)

Links to: projects/budget.md, projects/team.md
---

Summarize any important changes to project files.
```

---

## Memory Constraints

The snapshot cache stores full file content strings. Conservative limits:

- **MAX_SNAPSHOTS = 200** — covers most active trigger scenarios
- **SNAPSHOT_TTL = 30 minutes** — prevents stale accumulation
- **Worst case:** 200 files × ~10KB avg = ~2MB memory
- **Typical case:** 20-50 active files × ~5KB = ~100-250KB

The cache is cleared on:
- Plugin unload
- TriggerScheduler.stop()
- Files that no longer match any active glob trigger (via TTL eviction)

---

## Acceptance Criteria

1. File-change triggers include a line-level diff showing what was added/removed
2. When no previous snapshot exists, the trigger includes the current file content
   (truncated to 2000 chars)
3. Diffs are capped at 1500 chars to prevent prompt blowup
4. Related files (backlinks + forward links) are listed when VaultIndex is available
5. Snapshot cache stays within 200-entry limit with 30-minute TTL
6. The 5-second per-trigger cooldown is preserved (no regression)
7. Cron-based triggers (which have no file context) are unaffected

## Non-Goals

- Character-level or word-level diffs (line-level is sufficient)
- Git-style unified diff format
- Snapshot persistence across plugin reloads
- Trigger-specific scope configuration (all triggers share the same scope model)
