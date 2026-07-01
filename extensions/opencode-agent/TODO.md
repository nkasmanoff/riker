# opencode-agent — TODO / Next Steps

Status of the opencode-as-native-chat-agent integration for this Code-OSS build,
and what's left to do. Pick up from here.

## Done

### Recent (2026-07-01)
- **Session cost no longer stuck at $0.000** (`src/opencode.js`): the status-bar
  and `/usage` cost was read from a separate, untested `step-finish` `part.cost`
  path, which never populated — so spend showed `$0.000` while context % worked
  (tokens come from the assistant `message.updated` event). Cost lives on the
  assistant message itself (cumulative per message, sibling to `tokens`), so it's
  now captured from the same `message.updated` event (`costByMessage` keyed by
  message id, latest value wins → summed in `totalCost()`). The old step-finish
  sum is kept only as a fallback for server versions that report cost there.
  Covered by the extended `test/unit.js` tokens+cost turn-complete test.
- **Approval prompts survive an unfocused window** (`src/extension.js`): the
  edit/command approval prompts switched from `showInformationMessage` (a toast
  that auto-hides and buries the turn in the notification center) to a persistent,
  `ignoreFocusOut` QuickPick (`requestApproval`) — the turn can no longer get
  silently stuck on "Waiting for approval…". Additionally, when the window is
  **not** focused, a best-effort OS notification fires (`notifyIfUnfocused`:
  `osascript` on macOS, `notify-send` on Linux; setting
  `opencode.approval.notifyWhenUnfocused`, default on) so a blocked turn is
  noticed while working in another app. The QuickPick stays the actual
  approve/deny UI; the banner is only an attention-grabber. (Partially addresses
  Next Steps §1 — an in-chat confirmation part is still the richer eventual UX.)
- **Blocked-permission turns can't hang / "forget" the conversation**
  (`src/opencode.js`): the message POST now carries the turn's abort signal, and
  `permission.asked` ids are tracked (`pendingPermissionIds`) and replied
  `reject` on interrupt (mirroring the question path). Previously an interrupt
  while a tool was blocked on a permission gate left the POST open (server itself
  waiting on us) until the 10s safety net, and the handler couldn't return its
  session id — so the next turn couldn't resume and the chat appeared to forget
  the conversation. Covered in `test/unit.js`.
- **Attached image *files* shipped as media parts** (`src/context.js`,
  `src/lmProvider.js`): the context forwarder already sent *pasted/dragged* images
  as `data:`-URL `file` parts, but an attached image **file** `Uri` was inlined as
  a "open it with your tools" text note the model couldn't see. Now consumable
  formats (png/jpg/gif/webp/bmp) are read and shipped as media parts too
  (`imageMimeForPath`; svg/ico still fall back to a text note). Required flipping
  the provider's `imageInput: true` capability — the chat input gates the image
  attach/paste/drag affordances on the picked model's `vision` flag, which maps
  from this, so without it the chat silently refused images despite `context.js`
  forwarding them. Covered in `test/unit.js`.

- **Terminal in the loop** (Cursor parity). Two halves:
  - *Agent shell output rendered* (`src/toolOutput.js`): `bash` tool results used
    to collapse to a one-line "done" progress row even though opencode captured
    stdout/stderr (`state.output` → `tool-result.content`). Now rendered as a
    fenced block under the progress row — tail-capped (last 40 lines / 4k chars),
    fence-safe (`fenceFor` sizes the fence past any backticks in the output), and
    labeled success/failure. Wired in `extension.js` `onEvent` `tool-result`.
  - *Terminal attachment polish* (`src/context.js`): VS Code's built-in Terminal
    attachment (`supportsTerminalAttachments`, enabled by default for our widget)
    arrives as a `terminalCommand` string reference `Command: …\nOutput:…\nExit
    Code: …`. `context.js` already forwarded it generically; now
    `parseTerminalAttachment` recognizes it and `terminalBlock` renders a clean
    `Terminal command (exit N)` block (command in a ```bash fence, output capped)
    with a `terminal: <cmd>` summary label. Pasting raw text still works as plain
    prompt text. (Note: attachments are per-command, requiring shell integration;
    there is no passive "watch every terminal" view — opencode's own `bash` tool
    covers running new commands.)
  - *Paste terminal text → "Pasted text" chip* (core patch, Cursor's
    copy-from-terminal→paste→registered flow). Core's chat paste providers only
    turned a paste into an attachment when it carried VS Code *editor* copy
    metadata (`COPY_MIME_TYPES`); terminal copies are bare `text/plain`, so they
    were dumped inline and never registered as context. Added
    `PastePlainTextProvider` in `chat/browser/widget/input/editor/
    chatPasteProviders.ts`: on automatic paste of a sizable plain-text block
    (≥ 5 lines or ≥ 400 chars, no editor metadata) into the chat input, it
    registers a `paste` attachment chip ("Pasted text", value = the raw text →
    forwarded to opencode as a string reference, inlined by `context.js`). Yields
    to the image/code/symbol/html providers; short pastes still go inline.
  - *Add terminal selection to chat* (`src/terminalContext.js`, Cursor's
    select-terminal-text→ask flow). Core never wired terminal text into chat as
    context (a Copilot-extension feature), so we add it: the
    `opencode.addTerminalSelectionToChat` command reads `activeTerminal.selection`
    (`terminalSelection` proposed API) and opens the panel with the text attached
    as a `generic` chip via the new `attachText` option on
    `workbench.action.chat.open` (core patch below). The chip reaches the
    participant as a string `request.reference`, which `context.js` inlines for
    opencode. Surfaced in the terminal right-click menu (`terminal/context`, when
    `terminalTextSelected`) and on `Cmd/Ctrl+Alt+L`. `formatTerminalSelection`
    fences the selection (fence widened past backticks) and labels it by terminal
    name; unit-tested.
- **Editor Explain/Fix/Code Review → chat panel** (see core patch below). The
  participant stays `locations: ["panel"]` only: the inline-chat zone and
  terminal-chat widget do **not** render opencode's streamed markdown (the inline
  zone blocks on its own editing session and opencode streams via the chat
  response stream / surfaces edits through `externalEdit`, not the inline textEdit
  protocol). So instead of lighting up those zones, the editor AI entry points
  open the panel — opencode's native, fully-rendering surface — with the selected
  code inlined. The handler is still location-aware (`request.location` /
  `request.location2`, harmless for panel) should an inline surface ever be
  revisited with a dedicated low-tool agent. Notebook omitted.
- **Rate-limit info in the status bar** (`src/rateLimit.js`) — opencode doesn't
  expose provider rate-limit headers, so we parse its error text for 429 / 529 /
  "rate limit" / "overloaded" / "quota" signals (+ an optional retry-after in
  seconds/minutes). A hit sets a cool-off window; the status bar shows
  `$(warning) rate limited Ns` with a warning background and self-clears when the
  window elapses. `parseRateLimit` covered in `test/unit.js`.
- **Inline-completion polish** — per-language disabling
  (`opencode.inlineCompletions.disabledLanguages`, `isLanguageEnabled`); accept
  next word/line work out of the box via VS Code's built-in inline-suggest
  commands (`Cmd/Ctrl+→`, `editor.action.inlineSuggest.acceptNextLine`),
  documented in the setting. (Streaming ghost text isn't applicable to
  `InlineCompletionItemProvider`, which returns complete items.)
- **Ghost-text inline completions** (`src/inlineCompletions.js`,
  `opencode.inlineCompletions.*`): replaces Copilot's completions with an
  `InlineCompletionItemProvider` backed by a fill-in-the-middle model server.
  Backend-flexible (`api` setting): `openai` posts `{ prompt, suffix, … }` to an
  OpenAI-compatible `/v1/completions` (the `suffix` field is the FIM context) and
  reads `choices[0].text`; `llama` posts `{ input_prefix, input_suffix, … }` to
  llama.cpp's `/infill` and reads `content`. Default endpoint
  `http://127.0.0.1:8765/v1/completions`. Robustness: 120ms debounce on
  automatic triggers (skipped on explicit invoke), 2s request timeout linked to
  the cancellation token, prefix/suffix clamped (4k/1k chars), completion cleaned
  (length cap + suffix-overlap trim so FIM models don't duplicate trailing
  brackets), and a circuit breaker that backs off 60s after 3 consecutive
  failures so a down server never spams requests or adds keystroke latency. Pure
  helpers (`clampContext`, `buildRequestBody`, `parseCompletion`,
  `cleanCompletion`) covered in `test/unit.js`. No core patch (stable API).
- **Checkpoint restore reverts files (Cursor parity)** — clicking "Restore
  Checkpoint" now rewinds files, not just the chat. Root cause (see old §0): the
  only edit surface that records into the checkpoint timeline is
  `stream.externalEdit()`, and its baseline came from `entry.save()` snapshotting
  the in-memory model — which, when an editor held the post-edit content, saved
  "after" as the baseline (before == after → no operations recorded → restore
  was a silent no-op). Fix uses the engine's already-present-but-unbridged
  `contentFor` path on `start/stopExternalEdits` (`chatEditingSession.ts` reads
  the baseline from an explicit URI instead of save()). Threaded it through:
  `externalEdit(target, callback, { before })` (proposed API) →
  `extHostChatAgents2.ts` sends `contentFor` on the start message →
  `mainThreadChatAgents2.ts` passes it to `start/stopExternalEdits`. `surfaceFileEdits`
  now reconstructs the pre-turn original, writes it to a temp file, and registers
  the edit with `{ before: tempUri }` (disk keeps "after" throughout — never
  rewound, so no open-editor race); temp files are deleted after the turn.
  Requires `npm run compile` (engine changed). (`src/extension.js`, core patches
  below)
- **Follow-up suggestion chips** (`src/followups.js`, `opencode.suggestFollowups`):
  a `ChatFollowupProvider` on the participant suggests up to three next steps
  under each response, derived from the turn's result metadata (`mode`,
  `filesEdited`, `hadError`) — e.g. "Review the changes for bugs" / "Add or update
  tests" after edits, "Implement this plan" after `/plan`, "Try a different
  approach" after errors. Deterministic, instant, and free (no model call / no
  API key). Covered in `test/unit.js`.
- **Attached context forwarded to opencode** (`src/context.js`): the handler used
  to send only `request.prompt`, silently dropping everything the user explicitly
  attached. Now `request.references` is converted into opencode message parts:
  files (Uri) and selections (Location) are inlined as fenced code blocks
  (path + content / line range), folders are listed shallowly, plain-string
  context is inlined verbatim, and pasted images (`ChatReferenceBinaryData`,
  proposal `chatReferenceBinaryData`) become `data:`-URL `file` parts (opencode
  passes media parts straight to the model). Text is inlined directly rather than
  relying on opencode resolving `file://` parts, so it's version-independent and
  the model sees content immediately; size is capped per-file (64 KB) and overall
  (256 KB). Context rides along as a leading text part on the same user message,
  so the SSE echo filter (`userMessageIds`) drops it from rendering.
  `driver.send(text, { contextText, fileParts })`. Covered in `test/unit.js`.
- **Live TODO checklist** (`src/todos.js`): opencode's `todowrite` tool used to
  collapse into a generic "TodoWrite — done" progress row. It now renders as a
  Markdown checklist (`- [x]` / `- [ ]`, in-progress + cancelled states, a
  `done/total` count) in the response, re-rendered when the list meaningfully
  changes (dedup via `todoSignature`, since chat markdown is append-only) so the
  plan visibly fills in as opencode advances. `todoread`/result rows for
  `todowrite` are suppressed. Covered in `test/unit.js`.
- **Command (bash) approval gate** (`opencode.commandApproval`, default `ask`):
  parity with the edit gate, for shell commands. New sessions force `bash` to
  `ask` (`buildSessionRuleset`) when gating is on, so the prompt fires regardless
  of the user's opencode config. The blocked command is streamed into chat as a
  ```bash block, then a notification offers Allow / Allow for Session / Deny —
  `once` / `always` / `reject` to the server. `auto` (or no callback) preserves
  the old auto-approve-`always` behavior; other permissions (webfetch,
  doom_loop, external_directory) still auto-approve. `approveCommand` driver
  callback mirrors `approveEdit`. Covered in `test/unit.js`.
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
- **Editor Explain/Fix/Code Review routed to opencode (chat panel)** — the editor
  context menu + AI code actions (`chat.internal.explain` / `fix` / `review`)
  funneled into the Copilot `@workspace /explain` / anonymous-setup flow, which in
  this build only errors with "GitHub.copilot-chat cannot be installed". Repointed
  them at the chat panel (`CHAT_OPEN_ACTION_ID`, default agent = opencode) with the
  selected code inlined into an auto-submitted prompt. (First tried inline chat,
  but the inline zone doesn't render opencode's output — see the editor-chat note
  above; the panel does.)
  - `src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupProviders.ts` —
    `AICodeActionsHelper.explain(code, languageId, markers)` / `fix(...)` /
    `review(code, languageId)` build a `CHAT_OPEN_ACTION_ID` command (selection
    fenced in the query, diagnostics appended). Code-action call sites pass
    `model.getValueInRange(range)` + `model.getLanguageId()`.
  - `src/vs/workbench/contrib/chat/browser/chatSetup/chatSetupContributions.ts` —
    `registerGenerateCodeCommand` builds the selected text (falling back to the
    cursor line) and routes all three to those helpers (review no longer runs the
    anonymous-setup funnel). (Requires `npm run compile`, Node 24.)
- **Copilot "Agents window" entry points disabled** — the dedicated Agents window
  (`src/vs/sessions`, a separate Electron app) is a Copilot-CLI / cloud-agent
  surface that opencode does not back: it opens titled "New session … with
  **Copilot CLI**" and "No models available". opencode can't be registered as an
  agent-host/session provider without implementing that whole protocol, so the
  window is dead weight in this build. Suppressed both reachable entry points:
  - `src/vs/workbench/contrib/chat/common/constants.ts` — added
    `ContextKeyExpr.false()` to `OPEN_AGENTS_WINDOW_PRECONDITION`, which gates the
    `Open Agents Window` / `Open Workspace in Agents Window` commands and all their
    menu items (command palette, title-bar submenu, etc.).
  - `src/vs/workbench/contrib/chat/browser/agentSessions/agentSessionsBanner.ts` —
    `canShowAgentsBanner` now returns `false`, killing the welcome-page
    "Try out the new Agents window" promo banner. (Requires `npm run compile`,
    Node 24.)
- **`attachText` option on `workbench.action.chat.open`** — core's chat-open
  command could attach files, screenshots, and SCM history, but not arbitrary text
  snippets, so an extension had no way to drop terminal output into the chat as a
  context chip.
  - `src/vs/workbench/contrib/chat/browser/actions/chatActions.ts` —
    `IChatViewOpenOptions` gains `attachText?: { text; name }[]`; the handler adds
    each as a `generic` attachment (`attachmentModel.addContext`, `value` = the
    raw text, `modelDescription` = name) so it shows as a chip and forwards to the
    participant as a string reference. Used by `opencode.addTerminalSelectionToChat`
    (see "Add terminal selection to chat"). (Requires `npm run compile`, Node 24.)
- **externalEdit `before`/`contentFor` (checkpoint restore)** — three tiny edits
  that thread an existing-but-unbridged engine capability out to the extension
  API:
  - `src/vscode-dts/vscode.proposed.chatParticipantAdditions.d.ts` —
    `externalEdit` gains an `options?: { before?: Uri | readonly Uri[] }` param.
  - `src/vs/workbench/api/common/extHostChatAgents2.ts` — `externalEdit` sends
    the before-content URIs as `contentFor` on the start message.
  - `src/vs/workbench/api/browser/mainThreadChatAgents2.ts` — passes
    `revive(progress.contentFor)` to `start/stopExternalEdits` (the session
    method already accepted it). (Requires `npm run compile`, Node 24.)

## Next Steps (deferred)

### 0. Checkpoint restore — residual edge
Done (see above). Remaining edge: a file *created* this turn restores to empty
rather than being deleted (we record a `''`→after edit, not a Create, because
opencode already wrote the file to disk so we can't observe a `undefined`
baseline). Acceptable; true deletion would require deleting the file before the
externalEdit so the engine records a Create operation.

### 1. Approval UX upgrades
The per-edit and per-command approve/deny gates are live (see Done), now via a
persistent QuickPick (was a toast) plus an OS notification when the window is
unfocused. Possible refinements:
- Render the prompt as an in-chat confirmation part instead of a QuickPick
  (mid-turn `stream.confirmation` replies arrive as a *new* chat request, so
  this needs a queued-request dance — investigate). This is the richer eventual
  UX the QuickPick is a stopgap for.
- Extend the unfocused OS notification to `question.asked` prompts too (it
  currently only covers the edit/command approval QuickPick).
- Extend asking to `webfetch` (currently auto-"always") behind a setting.
- Auto-approve an allowlist of obviously-safe read-only commands
  (`ls`, `cat`, `git status`, …) so command `ask` mode is less noisy.

### 2. Remaining polish
- **Rate-limit info**: DONE (see Done) — parsed from opencode error text into a
  status-bar warning. Could be improved if opencode ever exposes structured
  provider rate-limit headers (exact remaining/reset rather than a heuristic
  cool-off).

### 2b. Copilot-surface audit (2026-06-12) — remaining candidates
Full sweep of `product.defaultChatAgent` consumers + `Setup.completed.negate()`
nudges. Fixed: SCM input sparkle, merge-conflict "Resolve Conflicts with AI"
(both disabled via `ContextKeyExpr.false()`, see core patches); editor
Explain/Fix/Code Review (rerouted to the opencode chat panel, see Done —
inline chat was tried and reverted). Remaining, in rough priority order:
- **Inline editor chat (Cmd+I)** — tried (`"editor"` location + selection
  context) but **reverted**: the inline-chat zone doesn't render opencode's
  streamed markdown/edits (it speaks the inline textEdit protocol + blocks on its
  own editing session; opencode streams via the chat response stream and surfaces
  edits through `externalEdit`). Editor Explain/Fix/Review now route to the panel
  instead (see Done). A real inline experience would need a dedicated agent that
  returns inline `TextEdit`s — non-trivial; deferred.
- **Terminal chat (Cmd+I in terminal)** — likewise reverted (same rendering gap,
  unverified). Deferred with the inline-editor work above.
- **Ghost-text inline completions** — DONE (see Done above): an
  `InlineCompletionItemProvider` backed by a configurable FIM server
  (`opencode.inlineCompletions.*`). Possible follow-ups: stream/partial
  completions, accept-word/line keybindings, per-language enablement, an
  OpenRouter backend mode, and a "completions paused/active" status-bar hint.
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
  `npm run compile` (always with `NODE_OPTIONS=--max-old-space-size=8192`, Node
  24, or tsc OOMs — the "Requires `npm run compile`" notes above all imply this).
  Note: the repo's `.claude/CLAUDE.md` (inherited from upstream VS Code) says
  *never* use `npm run compile` and to prefer the watch task /
  `compile-check-ts-native` / gulp — that guidance is upstream's; for this fork's
  one-shot engine-patch rebuilds `npm run compile` is what we use. If an agent is
  following CLAUDE.md strictly, `compile-check-ts-native` still type-checks
  `src/` changes without a full build.
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
  git checkout opencode && git merge main   # resolve conflicts in our core files (15, listed below)
  npm i && npm run compile                  # engine changed → recompile
  ```
  Our core-patch surface is intentionally tiny (15 files: `product.json`,
  `extHostLanguageModels.ts`, `chatStatusEntry.ts` — the Copilot "Sign In"
  status-bar entry is rebranded to an "opencode" entry (`$(hubot) opencode`)
  that opens the chat view via `CHAT_OPEN_ACTION_ID` instead of firing the
  defunct Copilot setup flow (the sign-in/entitlement affordance logic is
  dropped), `chatTipCatalog.ts` — the Plan-mode tip's dead
  `workbench.action.chat.openPlan` link (unregistered with Copilot gone) is
  rewired to open the chat view prefilled with `/plan `,
  `scmInput.ts` — Copilot setup sparkle disabled in the SCM input menu,
  `scm.contribution.ts` — same for "Resolve Conflicts with AI", `chatSetup/
  chatSetupProviders.ts` + `chatSetup/chatSetupContributions.ts` — editor
  Explain/Fix/Code Review rerouted to the opencode chat panel, `chat/common/
  constants.ts` + `agentSessions/agentSessionsBanner.ts` — the Copilot "Agents
  window" entry points and promo banner disabled, `chat/browser/actions/
  chatActions.ts` — the `attachText` chat-open option for terminal-selection
  context, `chat/browser/widget/input/editor/chatPasteProviders.ts` — pasted
  plain-text blocks (terminal output) registered as "Pasted text" chips, plus the
  externalEdit `before`/`contentFor` threading in
  `vscode.proposed.chatParticipantAdditions.d.ts`, `extHostChatAgents2.ts`, and
  `mainThreadChatAgents2.ts`) + the self-contained `extensions/opencode-agent/`
  + `oc`, so merges should rarely conflict. After any merge, sanity-check the
  proposed APIs we use (`externalEdit` incl. the `before` option,
  `thinkingProgress`, `chatProvider`) still exist.
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
