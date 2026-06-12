# Riker

Riker is a fork of [Visual Studio Code – Open Source ("Code - OSS")](https://github.com/microsoft/vscode)
that replaces GitHub Copilot with [**opencode**](https://opencode.ai) as the
native, built-in chat agent. The agent is wired directly into VS Code's chat
panel and Source Control view — no marketplace extension, no Copilot account.

> Built on Microsoft's MIT-licensed Code-OSS. See [License](#license) and
> [Upstream](#upstream-code---oss) below.

## What's different from Code-OSS

- **opencode as the default chat agent.** A bundled built-in extension
  (`extensions/opencode-agent`) registers a default chat participant
  (`@opencode`) that drives the [opencode CLI](https://opencode.ai) and streams
  responses — including reasoning tokens, tool calls, and file diffs — into the
  native chat view. It talks to a long-lived `opencode serve` process over its
  REST/SSE API for true token-by-token streaming.
- **Rebranded as "Riker"** in `product.json` (application name, bundle id, URL
  protocol, icons, etc.).
- **Copilot removed.** The Copilot setup "sparkle" actions in the editor and
  Source Control input are hidden, since Copilot is not part of this build.
- **Editable system prompt.** Run `/system` in chat to open opencode's full
  system prompt (the built-in agent prompt plus your extra instructions) as a
  saveable markdown document. The base prompt is vendored under
  `extensions/opencode-agent/prompts/builtin/`.
- **Usage tracking.** A status-bar item shows session cost and context
  consumption; `/usage` prints a detailed token/cost report for the session.
- **AI commit messages.** A sparkle button in the Source Control input box
  generates a commit message from your staged diff via OpenRouter.
- **Interactive questions.** opencode's `question`/`ask` tool is surfaced as a
  native quick-pick so the agent can ask you to choose between options mid-turn.

### Chat commands

| Command    | Description                                                            |
| ---------- | ---------------------------------------------------------------------- |
| `/plan`    | Run opencode in read-only Plan mode.                                   |
| `/system`  | Edit extra system instructions (`/system <text>` sets, `clear` resets).|
| `/usage`   | Show context, token, and cost usage for the session.                   |

## Prerequisites

1. **opencode CLI** — the agent shells out to it. Install and authenticate:

   ```bash
   # install (see https://opencode.ai for other methods)
   curl -fsSL https://opencode.ai/install | bash

   # log in to a provider (Anthropic, OpenAI, OpenRouter, etc.)
   opencode auth login
   ```

   Riker auto-detects the binary at `~/.opencode/bin/opencode`, Homebrew, or
   `/usr/local/bin`. To point at a custom location, set `OPENCODE_CLI` to its
   absolute path.

2. **(Optional) `OPENROUTER_API_KEY`** — only needed for the **Generate Commit
   Message** sparkle in Source Control. Export it in the shell you launch Riker
   from (it's the same variable opencode's OpenRouter provider uses):

   ```bash
   export OPENROUTER_API_KEY="sk-or-..."
   ```

3. **Build toolchain** for Code-OSS: Node.js (see `.nvmrc`), Python, and a
   C/C++ compiler. See the upstream
   [How to Contribute](https://github.com/microsoft/vscode/wiki/How-to-Contribute#build-and-run)
   guide for platform-specific build dependencies.

## Build and run from source

```bash
git clone https://github.com/nkasmanoff/riker.git
cd riker

# Use the Node version pinned in .nvmrc
nvm use            # or install that version manually

npm install        # installs dependencies (runs against electron headers)
npm run watch      # incremental compile; leave running in one terminal
```

Then launch the dev build in a second terminal:

```bash
./scripts/code.sh          # macOS / Linux
# .\scripts\code.bat       # Windows
```

This opens the Riker desktop app with the opencode agent already active. Open
the Chat view and start a conversation with `@opencode` (it's the default
participant, so you can also just type).

> First run: make sure you've run `opencode auth login` beforehand, otherwise
> the agent will report an authentication error from the opencode server.

### Settings

Configure under **Settings → Extensions → opencode Agent**, or in
`settings.json`:

| Setting                       | Default           | Purpose                                                                 |
| ----------------------------- | ----------------- | ----------------------------------------------------------------------- |
| `opencode.editApproval`       | `ask`             | `ask` to approve each file edit before it's applied, or `auto` to apply and review after. |
| `opencode.systemPrompt`       | `""`              | Extra instructions appended to opencode's agent prompt every turn.       |
| `opencode.commitMessageModel` | `openrouter/auto` | OpenRouter model slug used by **Generate Commit Message**.               |

## Working with upstream

This fork keeps Microsoft's repository as the `upstream` remote so you can pull
in new VS Code releases:

```bash
git remote -v
# origin    https://github.com/nkasmanoff/riker.git   (your fork)
# upstream  https://github.com/microsoft/vscode.git    (Code-OSS)

git fetch upstream
git merge upstream/main      # resolve conflicts in product.json etc. as needed
```

The opencode integration lives entirely in `extensions/opencode-agent/`, plus
small edits to `product.json` and the two SCM contribution files that hide the
Copilot sparkles — keeping the conflict surface with upstream small.

### Running the extension tests

```bash
node extensions/opencode-agent/test/unit.js
```

## Upstream (Code - OSS)

Riker is built from [microsoft/vscode](https://github.com/microsoft/vscode),
the open-source core of Visual Studio Code. Refer to upstream for the editor
architecture, bundled extensions, dev container, and contribution guidelines.
This fork is **not affiliated with or endorsed by Microsoft.**

## License

Riker is distributed under the [MIT](LICENSE.txt) license, the same license as
Code-OSS.

Copyright (c) Microsoft Corporation. All rights reserved. (Original Code-OSS
code and third-party notices retain their copyright.)
