# opencode-agent — TODO / Next Steps

Status of the opencode-as-native-chat-agent integration for this Code-OSS build,
and what's left to do. Pick up from here.

## Done

- **Chat participant** `opencode.agent` (`isDefault: true`) drives opencode
  and streams output into the native chat view. Session continuity via the
  opencode session id (stored in result metadata, replayed across turns).
- **True streaming via `opencode serve`** (replaced `opencode run --format
  json`): the run command only emits parts *after* they complete
  (`part.time?.end` gate in opencode's `cli/cmd/run.ts`) and drops reasoning
  entirely unless `--thinking` (default off non-interactively) — so nothing
  streamed and thinking never appeared. The driver now talks to a persistent
  `opencode serve` (one shared process per window, `src/server.js`):
  - `GET /event` SSE → `message.part.delta` events stream text AND reasoning
    token-by-token; `message.part.updated` reconciles full part text.
  - `POST /session` / `POST /session/{id}/message?directory=…` per turn;
    `session.idle` is the authoritative end-of-turn (10s safety net after the
    POST resolves). `POST /session/{id}/abort` on cancel.
  - The SSE stream echoes our own prompt's message parts; user-role message
    ids are tracked from `message.updated` and filtered out.
  - `permission.asked`: edits go through the approval prompt (see below);
    everything else is auto-approved "always" (parity with non-interactive
    `run`).
  - Faster turns too: no per-turn process spawn / instance bootstrap.
  - The `directory` query param anchors opencode to the workspace folder
    (replaces the old `env.PWD` hack).
- **Pre-apply edit gate ("B1") — blind overwrites solved**: sessions are
  created with a permission ruleset
  (`[{ permission: 'edit', pattern: '*', action: 'ask' }]`), so every file
  edit fires `permission.asked` *before* the tool writes to disk (the tool
  blocks until we reply). That event carries `metadata.diff` — the exact
  old→new unified patch opencode computes pre-write (verified live: file on
  disk still had the old content at ask time). The driver stashes it by
  `tool.callID`, replies `"once"` (so the next edit asks again → fresh diff
  every time), and attaches it to the tool result as `fileEdit.gateDiff`.
  Result: even a blind `write` overwrite with no prior read gets an inline
  diff AND a validated accept/reject pill (`reconstructBefore` reverse-applies
  the gate diff against disk content; falls back to snapshot-on-read, then
  plain reference). Sessions resumed from before this change have no ruleset
  and degrade gracefully. (`src/opencode.js`, `src/fileEdits.js`)
- **Per-edit approval UI**: the gate reply is delegated to an `approveEdit`
  callback (`OpencodeDriver` option). While the tool is blocked pre-write,
  the extension streams the *pending* diff into chat (deduped from the
  post-apply render by callID), then prompts via notification:
  Allow / Allow for Session / Deny. Deny replies `"reject"` — the tool
  errors, nothing touches disk, and the model is told (verified live:
  denied edit left the file byte-identical). Dismissing the prompt counts
  as deny (never apply silently). "Allow for Session" stops prompting for
  the rest of the window but keeps replying `"once"` under the hood, so
  gate-diff capture stays alive. Setting: `opencode.editApproval`
  (`"ask"` default / `"auto"` = old auto-apply behavior with Keep/Undo
  review). (`src/opencode.js`, `src/extension.js`, `package.json`)
- **Inline streaming diffs (Cursor-style)**: each `edit`/`patch`/`write`
  tool result immediately renders a fenced ```diff block in the response
  (filename + hunks, capped at 300 lines). Diff source preference:
  `metadata.filediff.patch` (server provides it) → `metadata.diff` →
  `gateDiff` (pre-apply gate; covers blind overwrites) → synthesized for
  writes (all-`+` for new files; LCS unified diff `computeUnifiedDiff`
  against the read snapshot for overwrites; unit-tested with reverse-apply
  as the oracle). (`src/fileEdits.js` `displayDiff`, `src/extension.js`)
- **Language model provider** (`vendor: "opencode"`) registers opencode's 8
  models so `request.model` resolves and the native model picker populates.
  - Fires `onDidChangeLanguageModelChatInformation` once after registration to
    trigger initial resolution into the main-thread cache.
  - Advertises `capabilities.toolCalling: true` so models pass the Agent-mode
    filter (`suitableForAgentMode`) and appear in the picker.
- **Model selection honored**: handler uses `request.model.id` (the raw opencode
  model id) instead of a hardcoded default. (`src/extension.js`)
- **File-edit accept/reject** (apply-then-review / "B2"): edits are collected
  during a turn, then surfaced via `stream.externalEdit()` using a
  restore-then-replay technique. Diffs are reconstructed by reverse-applying
  opencode's `metadata.diff`, with strict validation + safe fallback to a plain
  reference. Works for `edit`/`patch` and new-file `write`.
  (`src/fileEdits.js`, `src/extension.js`)
- **Snapshot-on-read** (fallback for the gate): a complete, lossless `read`
  tool output is parsed back into exact file content
  (`parseReadToolOutput`, `src/fileEdits.js`) and cached per turn. When the
  same file is later overwritten by `write`, the snapshot serves as a
  validated "before" (`afterText` must equal the write's `content`) if the
  gate diff is missing or doesn't apply. Partial reads (offset/limit
  windows, byte caps, truncated long lines, directories) are rejected; any
  intervening edit invalidates the snapshot. Caveat: the line-numbered read
  format can't represent a missing trailing newline — we assume one.
  Covered by `test/unit.js`.
- **Interactive questions** (`question.asked`): opencode's question tool used
  to stall/no-op — the event was never handled, so questions rendered nothing
  clickable in chat. Now the driver delegates to an `askQuestion` callback
  (same pattern as `approveEdit`) while the tool is blocked server-side, and
  the extension renders the full question + every option (with descriptions)
  expanded in the chat transcript, then collects the answer via QuickPick:
  clickable options, multi-select when `multiple`, free text via "Custom
  answer…" (opencode's `custom` defaults to true; InputBox), per-question
  progress for multi-question requests. Valid answers POST
  `/question/{id}/reply` (`{ answers: string[][] }` — selected labels per
  question); dismissal/errors POST `/question/{id}/reject` so the turn never
  hangs (the tool errors with "user dismissed" and the model continues).
  Cancelling the turn rejects pending questions before `session/abort`, and a
  late answer after interrupt is dropped (no double-reply). Driver-side flow
  covered in `test/unit.js` via a mocked server module.
  (`src/opencode.js`, `src/extension.js`)
- **Status bar cost + context**: a status bar item (right side) shows
  cumulative session spend and current context usage (`$0.12 · 17%`);
  tooltip has last-turn cost, session total, approximate context tokens vs
  the model's limit, and last-turn token breakdown. Hidden until the first
  turn reports cost or tokens. (`src/extension.js`)
- **`/system` — the FULL system prompt, viewable and editable**: bare
  `/system` opens `opencode:/system-prompt.md` (writable FileSystemProvider;
  also command palette "opencode: Edit System Prompt") showing both editable
  layers of the prompt with marker-delimited sections:
  - **BASE agent prompt** — the build agent's override if set (from
    `GET /agent`), else opencode's built-in provider prompt for the current
    model. The built-ins ship inside the binary and aren't exposed over the
    API, so exact copies are vendored in `prompts/builtin/` (pinned to
    v1.17.4; verified byte-identical to v1.15.10) with the selection logic
    ported from `SystemPrompt.provider()`
    (`src/systemPrompt.js` `builtinPromptName`, keyed on the catalog's
    `model.api.id`). Editing this section REPLACES the built-in prompt:
    saves write `agent.build.prompt` into the workspace's `opencode.json`
    (merge-preserving; refuses to clobber JSONC) and `POST /instance/dispose`
    so the running server reloads config (verified live). Restoring the
    built-in text exactly removes the override (and deletes `opencode.json`
    if it's now empty). **Gotcha:** `PATCH /config` is a dead end at
    v1.15.10 — it persists to `<dir>/config.json`, which the config loader
    never reads back (only `opencode.json`/`opencode.jsonc`; verified live).
  - **EXTRA instructions** — the `opencode.systemPrompt` setting (workspace
    target when a folder is open; also in Settings UI). Sent per turn as the
    message POST's `system` field, which opencode appends after the base
    (`LLMRequestPrep.prepare` joins `[agent.prompt ?? builtin, ...system,
    user.system]`). `/system <text>` sets inline, `/system clear` clears.
  - Not editable (regenerated each turn, noted in the doc header): the
    environment block, AGENTS.md instruction files, skills listing.
  - Saves only touch a section that actually changed vs what was rendered;
    mangled markers fail the save without writing anything. Doc build/parse
    + prompt selection covered in `test/unit.js`.
  (`src/systemPrompt.js`, `src/opencode.js` `configure/send`,
  `src/extension.js`, `prompts/builtin/`, `package.json`)
- **`/usage` — context/token/cost report in chat**: context tokens consumed
  (≈ last assistant message's input + cache read/write + output + reasoning)
  vs the model's context limit, last-turn token breakdown, last-turn +
  window cost, and the model's per-1M pricing. Limits/pricing come from
  `GET /config/providers` (cached per window; keys `providerID/modelID`
  match the CLI model ids — verified live). Token counts are captured in
  the driver from assistant `message.updated` events and emitted on
  `turn-complete`. Both `/system` and `/usage` are answered locally — no
  opencode turn is spent. (`src/opencode.js`, `src/extension.js`)
- **Error surfacing**: opencode errors and handler failures render as proper
  chat warning parts (`stream.warning`) instead of bold markdown.
- **Thinking/reasoning**: reasoning deltas stream through
  `stream.thinkingProgress({ id, text })` (collapsible reasoning UI), keyed
  by opencode part id. (`src/opencode.js` passes the id through.)
- **Plan mode UX**: `/plan` turns open with an info banner
  (`stream.info`) stating the read-only plan agent is active.
- **Unit tests**: `node test/unit.js` — standalone (no VS Code host) coverage
  for `parseReadToolOutput`, snapshot-validated `reconstructBefore`, and
  reverse-diff reconstruction. `test/smoke.js` still covers the live driver.
- **Edit pills made visible** (`configurationDefaults` in `package.json`):
  `stream.externalEdit` *was* already emitting per-file edit pills
  (`createOpeningEditCodeBlock` in `chatEditingSession.ts` pushes
  `codeblockUri` + `textEditGroup` parts), but the build default
  `chat.agent.thinking.collapsedTools: "always"` pinned them inside the
  collapsed "Working…" thinking container (`shouldPinPart`,
  `chatListRenderer.ts` ~2004), so they were effectively invisible. Default
  override to `"off"` renders them as top-level parts: "Edited <file> +N/-M"
  pill → click opens the diff editor; Keep/Undo lives on the chat input
  working-set toolbar. Also defaulted `chat.checkpoints.showFileChanges: true`
  for the end-of-response "Changed N files" summary (it requires
  `textEditGroup` parts, which `externalEdit` produces).
- **Thinking expandable while streaming**: default override
  `chat.agent.thinkingStyle: "collapsedPreview"` — reasoning streams fully
  expanded, auto-collapses when the turn moves on, and the header stays
  click-expandable afterwards. (Build default `fixedScrolling` only shows a
  200px auto-scrolling strip and blocks expansion until it overflows.)
- **Open VSX marketplace** (`../../product.json`): Code-OSS ships with no
  `extensionsGallery`, so the Extensions view has no search/install source
  (Microsoft's marketplace is license-restricted to official builds). Added
  the Open VSX gallery (`serviceUrl`/`itemUrl`/`resourceUrlTemplate`).
  Signature verification is a non-issue here: the check is skipped when
  `!environmentService.isBuilt` (dev builds), and unsigned installs are
  otherwise governed by `shouldRequireRepositorySignatureFor`.
- **Commit message generation (SCM sparkle) via OpenRouter**: Copilot's
  "Generate Commit Message" died with Copilot removed; replaced with
  `opencode.generateCommitMessage`, contributed to the `scm/inputBox` menu
  (proposed API `contribSourceControlInputBoxMenu`; the toolbar invokes it
  as `(rootUri, context, token)` per `SCMInputWidgetActionRunner`). Reads
  the staged diff (falls back to working tree + untracked list) and the
  last 8 commit subjects for style via the `vscode.git` API, then calls
  OpenRouter chat completions directly with the `OPENROUTER_API_KEY` env
  var (same one opencode's provider uses) and writes the result into
  `repo.inputBox.value`. Model: `opencode.commitMessageModel` setting
  (default `openrouter/auto`); 24k-char diff cap, 30s timeout, toolbar
  cancel honored. Verified live end-to-end. Prompt build/cleanup helpers
  unit-tested (`vscode` import is guarded so test/unit.js can load the
  module outside the host). (`src/commitMessage.js`, `package.json`)
  **Core patch required**: the built-in `scm.input.triggerSetup` sparkle
  (same title, same menu) runs the Copilot *setup* flow and then
  `product.defaultChatAgent.generateCommitMessageCommand` — both dead in
  this build, so clicking it always failed; with two actions in the menu it
  could also shadow ours as the primary. Disabled via `ContextKeyExpr.false()`
  in its menu `when` (`src/vs/workbench/contrib/scm/browser/scmInput.ts`,
  needs `npm run compile`).
- **Copilot removed from build**: launchers set
  `VSCODE_SKIP_BUILTIN_EXTENSIONS="GitHub.copilot-chat,GitHub.copilot"` so the
  bundled Copilot extension is never scanned/activated (it otherwise registers
  competing `isDefault` participants). `defaultChatAgent` in `product.json` left
  untouched on purpose (see Decisions below). (`../../oc`)

- **Product renamed to "Riker"** (Star Trek: the Number One who executes,
  while the captain — you — keeps the conn). `product.json`: `nameShort`/
  `nameLong` → `Riker`, `applicationName`/`urlProtocol` → `riker`,
  `darwinBundleIdentifier` → `com.riker.editor`, win32/linux names updated.
  `dataFolderName` (`.vscode-oss`) deliberately left unchanged so existing
  settings/extensions/state survive. New logo (white "R" with warp streak on
  a space squircle) installed at `resources/darwin/code.icns` (mac dock),
  `resources/linux/code.png`, `resources/server/code-{192,512}.png` +
  `manifest.json`. Dev bundle rebuilt via `npm run electron` →
  `.build/electron/Riker.app`; `scripts/code.sh` picks the name up from
  `product.json` automatically. Note: macOS keychain "safe storage" is keyed
  by app name, so previously stored secrets (e.g. GitHub auth) may require
  one re-login under the new name.

### Core engine patch
- `src/vs/workbench/api/common/extHostLanguageModels.ts` —
  `getDefaultLanguageModel` previously only honored a default model when
  `vendor === COPILOT_VENDOR_ID`. Patched to fall back to *any* vendor's
  default-for-Chat model so opencode can satisfy `request.model` with Copilot
  absent. (Requires `npm run compile`; needs
  `NODE_OPTIONS=--max-old-space-size=8192` or tsc OOMs.)

## Next Steps (deferred)

### 0. Checkpoint restore should restore files (parity with Cursor)
Clicking "Restore Checkpoint" rewinds the chat but does not revert files.
The workbench machinery exists and works natively: restore →
`ChatEditingSession.restoreSnapshot` → checkpoint timeline
`navigateToCheckpoint` rewrites disk from recorded baselines/operations
(`chatEditingCheckpointTimelineImpl.ts`). Files only revert if their edits
were *recorded in the timeline*, and the only extension surface that records
them is `stream.externalEdit()` — which we call in an end-of-turn batch.
Suspected failure points (in order):
1. `startExternalEdits` calls `entry.save()` before snapshotting
   (`chatEditingSession.ts:719-724`); if the file's in-memory model still
   holds the *after* content (open editor / entry reused from an earlier
   request), the save clobbers our restored "before" → before == after →
   no operations recorded → restore is a silent no-op for that file.
2. Files whose end-of-turn chain reconstruction fails fall back to
   `stream.reference()` and never enter the timeline.
Planned fix (~0.5–1 day): drive `externalEdit` per edit at tool-result time
using the pre-apply gate's exact before-content (gate now guarantees a
validated "before" for every edit), replacing the end-of-turn
restore-then-replay batch in `surfaceFileEdits`. Worst case needs a small
core patch in `chatEditingSession.ts` (+ `npm run compile`) if the `save()`
race persists.

### 1. Approval UX upgrades
The per-edit approve/deny gate is live (see Done) using a notification
prompt. Possible refinements:
- Render the prompt as an in-chat confirmation part instead of a
  notification (mid-turn `stream.confirmation` replies arrive as a *new*
  chat request, so this needs a queued-request dance — investigate).
- Extend asking to other permissions (bash, webfetch) behind the same
  setting, instead of auto-"always".

### 2. Remaining polish
- **Rate-limit info**: not parsed from the opencode stream yet; the status bar
  currently shows cost only.

### 2b. Copilot-surface audit (2026-06-12) — remaining candidates
Full sweep of `product.defaultChatAgent` consumers + `Setup.completed.negate()`
nudges. Fixed: SCM input sparkle, merge-conflict "Resolve Conflicts with AI"
(both disabled via `ContextKeyExpr.false()`, see core patches). Remaining,
in rough priority order:
- **Inline editor chat (Cmd+I)** — no `EditorInline` default agent, so inline
  chat is dark. Participant `locations` accepts `"editor"`
  (`ChatAgentLocation.fromRaw`); adding it + `isDefault` would light it up
  with opencode. Caveats: inline chat sessions set `canUseTools: false` and
  expect fast, localized responses — opencode's full agent loop edits files
  via its own tools, so UX needs thought (maybe a dedicated low-tool agent).
- **Terminal chat (Cmd+I in terminal)** — same story via `"terminal"`
  location; `terminalChatEnabler.ts` only needs a default Terminal agent to
  enable the UI. opencode could suggest/explain commands.
- **Ghost-text inline completions** — Copilot's completions are simply gone
  (provider-driven; engine's `completionsEnablement.ts` reads a Copilot
  setting name from `defaultChatAgent`, no provider registered). Could
  register an `InlineCompletionItemProvider` in opencode-agent backed by the
  local llama.cpp server (`north-mini-code` @ 127.0.0.1:8765, FIM-capable,
  zero cost/latency-friendly) or OpenRouter. Largest effort, biggest win.
- **Dormant/cosmetic, no action**: chat setup welcome views + terms
  disclaimers (chatQuick/chatWidget/agentSessionsWelcome), Getting Started
  walkthrough Copilot steps, `defaultAccount.ts` entitlement sync, extension
  gallery Copilot nudges, settings/search AI providers (hidden without a
  provider extension).

### 3. Productionizing the build (optional, more invasive)
- Decide whether to fully remove `extensions/copilot` from the source/compile
  graph (`compile-copilot`/`watch-copilot`) vs. the current scan-skip approach.
- Consider building opencode-agent through the normal extension build instead of
  plain CommonJS (currently `main: ./src/extension.js`, no compile step).
- Package/installer wiring if this becomes a distributable build.

## Key Decisions / Gotchas

- **opencode 1.15.x is unusable with a DB migrated to the `session_message.seq`
  schema** (upstream bug, fixed in 1.16.2+): every `POST /session/{id}/message`
  500s with `SQLiteError: NOT NULL constraint failed: session_message.seq` —
  the 1.15.x `appendMessage` on the `session.next.agent.switched` path (fires
  on every new session's first message) inserts without `seq`. The shared DB
  (`~/.local/share/opencode/opencode.db`) gets the new schema as soon as ANY
  newer opencode touches it (e.g. the OpenCode desktop app), silently breaking
  older CLIs. Symptom in chat: `UnknownError ... Check server logs`; logs at
  `~/.local/share/opencode/log/`. Fix: `opencode upgrade` (≥1.16.2) and kill
  any stale `opencode serve` so the extension respawns the new binary (it
  auto-respawns: `server.js` clears its cache on child exit).
- **Do NOT repoint `product.json` `defaultChatAgent` to opencode.** The runtime
  default agent is determined solely by a participant with `isDefault: true`
  (`chatAgents.ts:442-448`). `defaultChatAgent.extensionId/chatExtensionId` only
  wire Copilot-specific setup/sign-in/entitlement/built-in-tool plumbing.
  Repointing breaks the install flow, can auto-disable our extension, and
  triggers spurious GitHub auth prompts. Leave it as-is.
- The extension is **plain CommonJS** (no build step) — edit `src/*.js` and just
  restart the window; no recompile needed. Engine (`src/vs/**`) changes DO need
  `npm run compile`.
- **Node 24** is required to launch (`.nvmrc` pins 24.15.0); the `oc` launcher
  switches to it via nvm. Global default stays Node 22.
- Launch with `oc [path]` (alias in `~/.zshrc` → `../../oc`). Dev build, isolated
  `code-oss-dev` data dir.
- opencode CLI: `~/.opencode/bin/opencode` (standalone). Provides unified diffs
  in tool `metadata.diff` for `edit`/`patch` (but not for `write`); for `write`
  the only diff source is the pre-apply permission gate (`gateDiff`).

## Managing updates (fork + opencode)

- **VS Code**: this repo is a fork-style checkout — `upstream` =
  microsoft/vscode, our work lives on the `opencode` branch, `main` stays
  clean tracking upstream. To take an upstream update:
  ```
  git fetch upstream
  git checkout main && git merge --ff-only upstream/main
  git checkout opencode && git merge main   # resolve conflicts in our 4 core files
  npm i && npm run compile                  # engine changed → recompile
  ```
  Our core-patch surface is intentionally tiny (6 files: `product.json`,
  `extHostLanguageModels.ts`, `chatStatusEntry.ts`, `chatTipCatalog.ts`,
  `scmInput.ts` — Copilot setup sparkle disabled in the SCM input menu,
  `scm.contribution.ts` — same for "Resolve Conflicts with AI") +
  the self-contained `extensions/opencode-agent/` + `oc`, so merges should
  rarely conflict. After any merge, sanity-check the proposed APIs we use
  (`externalEdit`, `thinkingProgress`, `chatProvider`) still exist.
- **opencode**: installed at `~/.opencode/bin/opencode`; update with
  `opencode upgrade`. Our integration is tested against **v1.15.10–v1.17.4**
  (1.15.x had a fatal upstream bug — see Gotchas) and
  depends on server API surfaces that can drift across versions: the
  `/event` SSE shapes (`message.part.delta`, `message.part.updated`,
  `session.idle`), `POST /session` `permission` ruleset,
  `permission.asked` `metadata.{filepath,diff}`,
  `/session/{id}/permissions/{permissionID}` replies,
  `question.asked`/`/question/{id}/reply`, `GET /agent`,
  `GET /config/providers`, and `POST /instance/dispose`. The vendored
  built-in prompts (`prompts/builtin/`, shown in the `/system` editor) and
  the ported selection logic (`builtinPromptName`) are pinned to v1.17.4 —
  re-vendor from `packages/opencode/src/session/prompt/*.txt` and re-check
  `SystemPrompt.provider()` in `src/session/system.ts` after upgrading.
  Also re-test whether `PATCH /config` is still broken (writes unread
  `config.json`) — if fixed upstream, `_saveBaseOverride` could use it
  instead of writing `opencode.json` directly. After upgrading run
  `node test/unit.js && node test/smoke.js` (live smoke hits a real server)
  before trusting a new version.

## Relevant Files

- `src/extension.js` — chat participant handler, event→stream mapping,
  inline ```diff rendering, `surfaceFileEdits` (externalEdit accept/reject).
- `src/opencode.js` — `OpencodeDriver`: drives a session over the opencode
  server API (SSE deltas), emits normalized events incl. `fileEdit` metadata.
- `src/server.js` — shared `opencode serve` process manager + REST/SSE
  helpers (`getServerUrl`, `api`, `subscribeEvents`, `disposeServer`).
- `src/lmProvider.js` — language model provider (models + picker).
- `src/fileEdits.js` — reverse-diff reconstruction, read-output snapshot
  parser, validation guards.
- `test/unit.js` — standalone unit tests for the above (`node test/unit.js`).
- `src/descriptor.js` — model/mode discovery via `opencode models`.
- `src/resolveBin.js` — locate the opencode binary.
- `package.json` — manifest (proposed APIs, contributions).
- `../../oc` — dev launcher (`oc [path]`).
- `../../src/vs/workbench/api/common/extHostLanguageModels.ts` — engine patch.
