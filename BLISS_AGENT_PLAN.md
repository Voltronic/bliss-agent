# Bliss Agent Roadmap

## Goal

Transform Bliss Agent from a chat with file tools into a practical engineering agent for repository work, closer to an internal "Claude Code".

## Principles

- Prefer targeted search and local edits over full-file rewrites.
- Keep all actions scoped to the selected working directory.
- Separate safe read actions from mutating or risky actions.
- Validate after edits with build, test, lint, or diff.
- Make repo changes visible through plan, tool trace, and git outputs.

## Tracking

### Completed

- Root roadmap created.
- Repo tools added: `find_files`, `search_text`, `read_file_range`, `apply_patch`.
- Validation tools added: `run_build`, `run_test`, `run_lint`.
- Local git tools added: `git_status`, `git_diff`, `git_create_branch`, `git_add`, `git_commit`.
- Working-directory scoping fixed for tools.
- OpenRouter model fallback added.
- Dev launcher made robust against occupied Vite ports.
- Search performance improved with async scans and dependency-directory exclusions.
- Approval gating added for mutating and risky actions.
- Per-chat auto-approval is now available for one command type or for all gated commands in the current chat.
- The UI now shows active auto-approval state and lets the user turn it off without resetting the chat.
- File viewer panel in the UI for previewing files and search hits.
- Click-to-preview behavior from file and search results.
- GitHub readiness card in the UI backed by `gh auth status` and origin remote detection.
- Settings panel now has dedicated `Provider`, `GitHub`, and `Tools` tabs.
- Topbar now warns when the active provider key is missing and jumps directly to provider settings.
- GitHub repository, issue, and pull request context can now be read through `gh`.
- Draft pull requests can now be created through `gh` from the selected repository.
- Pull request review comments can now be read through GitHub CLI.
- Draft pull requests can now fall back to an auto-generated body with summary, changed files, and validation notes.
- `find_files` and `search_text` now run in a child process and stream progress updates back to the UI.
- Child-process search failures now fall back to main-process execution instead of failing the run.
- Provider switching now supports OpenRouter and Gemini AI Studio.
- Provider fallback status is surfaced in the UI, including selected model and exhausted fallback states.
- OpenRouter fallback now classifies provider errors, caches invalid models, and stops early on provider-wide free-tier quota exhaustion.
- The static OpenRouter fallback list was trimmed to currently valid compatible models.
- Prompt guidance was hardened with generic grounding rules for locating real files and entrypoints before editing.
- Backend discovery guardrails now block file mutations that target paths not discovered in the current run.
- Existing-file patching now requires the file to have been read in the current run before `apply_patch` is allowed.
- The thinking/loading indicator was restored and now stays visible until real progress appears.
- Active tool execution can now be cancelled without cancelling the whole run.
- Multiple chats are now available in the sidebar, with per-chat working directory and runtime state.
- Chats can now be renamed or deleted from the sidebar without leaving the current workspace.
- GitHub issue creation, issue comments, and PR comments now run through `gh`.
- GitHub issue/PR edit flows, issue/PR close-reopen flows, PR review submit, and PR merge now run through `gh`.
- Prompt guidance updated: after sufficient context, agent implements directly instead of asking how to proceed.
- Defensive normalisation of tool names emitted by the model, including names with accidental suffixes such as `<channel>`.

### In progress

- Optional GitHub API/token fallback only for environments where `gh` is unavailable or insufficient.

### Newly completed

- Provider settings now allow switching between the current OpenRouter fallback chain and Gemini AI Studio.
- GitHub auth-required cards can now launch browser login through `gh auth login --web` and auto-refresh status on return.
- Global secondary text colors were lifted for better readability.
- Existing-file grounding now requires a real file read before patching.
- Long-running tool execution can now be stopped independently of the full run.
- Multi-chat sidebar sessions now preserve chat-specific working directories and runtime state.
- Approval policy is now synced into the backend per chat, and backend-side auto-approval now drives gated tool execution instead of renderer-only interception.
- GitHub issue and PR flows now cover list/search, merge-readiness checks, review threads, thread replies, thread resolve/unresolve, reviewer updates, and ready/draft transitions through `gh` plus targeted API calls.
- Validation recovery now parses .NET, Node.js, and Python stack traces to target file-line ranges and pass the parsed failure summary into the next recovery turn.
- Chat history now auto-compacts older turns into a persisted summary when the context meter reaches 100%, and the composer shows the live context budget plus the stored summary preview.

### Planned

- Optional GitHub API/token fallback for environments where `gh` is unavailable or specific workflows still require direct API access.
- Richer model/provider controls and optional cross-provider fallback.

---

## Phase 4: Autonomous Agent Behaviour — Implementation Plan

Objective: close the behavioural gap between Bliss Agent and Claude Code. The agent must act autonomously on coding tasks, use tools instead of describing what it would do, self-correct after errors, and only pause when it hits a genuine blocker.

### P1 — Core agentic loop (blockers)

These items change the fundamental behaviour of the agent. Nothing below is worth addressing until these are solid.

#### 4.1 — Force tool use for code changes

The model must never output code in text as a final response when file-writing tools are available. Responding with a code block and no tool call is defined as task failure.

- Add an explicit rule to the system prompt: outputting code in text without calling `write_file` or `apply_patch` is not acceptable and counts as task failure.
- Add a secondary rule: never say "here is what you should change" — make the change directly.
- Verify at the renderer level: if a run ends with a response that contains a fenced code block and zero tool calls, surface a warning to the user and mark the run as incomplete.

#### 4.2 — Increase agentic loop iteration ceiling

If the iteration cap is set at 3 or lower, the agent consumes all turns on analysis and has no margin left for writing and verifying. Set the minimum to 10–15 turns for any run that involves file mutations.

- Raise the default `max_iterations` for coding runs to 15.
- Add a distinct lower limit (3–5) for read-only and search-only runs so those stay fast.
- Expose the current iteration count in the tool trace UI.

#### 4.3 — Read-after-write verification

After every `write_file` or `apply_patch` call, the agent must call `read_file` on the modified path to confirm the content is correct before continuing. This closes the loop and catches silent write failures.

- Encode the rule in the system prompt: after writing a file, always read it back to confirm.
- If the read-back content does not match what was intended, the agent must retry the write rather than reporting success.

#### 4.4 — Automatic build/error recovery loop

When `run_build`, `run_test`, or `run_command` returns a non-zero exit code, the agent must analyse the output, locate the relevant file and line, apply a fix, and re-run validation — without waiting for user input. Compilation errors and test failures are expected mid-task, not blockers.

- Add a recovery rule to the system prompt: if a build or test fails, read the error, identify the cause, fix it, and re-validate. Do not report the error to the user and wait — fix it first.
- Cap automatic recovery retries at 3 per task to prevent infinite loops.
- After 3 failed attempts, surface the full error log to the user and stop.

---

### P2 — Functional parity

#### 4.5 — Stack trace parser

When a runtime error or build failure is detected in tool output, extract the file path, line number, and error message before deciding what to read. This avoids reading entire files when only a small range is relevant.

- Implement a lightweight parser that recognises .NET, Node.js, and Python stack trace formats.
- After parsing, issue a `read_file_range` targeted at the relevant lines rather than a full `read_file`.
- Pass the extracted error summary as additional context in the next model turn.

#### 4.6 — Streaming output for `run_command`

Long builds currently block until completion with no visible progress. Emit output chunks to the UI in real time so the user can see what is happening and cancel early if needed.

- Stream stdout and stderr from `run_command`, `run_build`, and `run_test` as incremental UI updates.
- Preserve the full captured output for the model turn at the end of execution.

#### 4.7 — Structured end-of-run summary

At the end of every run, the agent emits a concise structured summary: files modified (with paths), commands executed, overall result (success or failure), and any suggested next steps.

- Add a rule to the system prompt: always close a run with a brief summary in the format — Changed, Ran, Result, Next.
- Render this summary in a distinct UI component separate from the tool trace.

#### 4.8 — Error history in multi-turn recovery

When the agent retries a fix, the previous error output and the failed attempt must be included in the next model turn. Without this, the model repeats the same incorrect fix.

- After a failed build or test, append the error output and the diff of the attempted fix to the conversation history before the next turn.
- Keep error history scoped to the current run; do not carry it across separate runs.

#### 4.9 — Unified diff support in `apply_patch`

If `apply_patch` currently does a full-file replacement, it loses granularity and produces noisy git diffs. Switch to unified diff format so patches are surgical and reversible.

- Accept unified diff input (`--- a/file`, `+++ b/file`, `@@ ... @@` hunks) in `apply_patch`.
- Fall back to full-file write only when the patch cannot be applied cleanly and the user confirms.
- Display a rendered diff in the file viewer after each successful patch.

#### 4.10 — Automatic stack/framework detection

At the start of each run, detect the project type from config files and inject it into the system prompt so the agent does not need to re-discover conventions mid-task.

- On working directory selection, scan for `package.json`, `*.csproj`, `*.sln`, `requirements.txt`, `Cargo.toml`, etc.
- Derive the stack label (e.g. `.NET 8 WinForms`, `Node/Vite`, `Flutter`) and the primary build/run commands.
- Inject a one-paragraph project context block at the top of every system prompt for that working directory.

---

### P3 — Polishing and UX detail

#### 4.11 — Token and cost tracking per run

Display the token count and estimated cost for each run at the end of the session. Useful for identifying prompts that are consuming unnecessary context.

- Track input and output tokens returned by the provider API per turn.
- Accumulate totals per run and display them in the run summary component.
- Show a per-chat aggregate in the sidebar.

#### 4.11a — Chat context summarisation when history gets too large

Long chats should not keep growing until they become slow, expensive, or unstable. When the retained per-chat context exceeds a safe size, Bliss Agent should compact older turns into a structured summary and keep only the recent working set plus the summary.

- Define a context budget per chat based on message count, approximate tokens, or serialized size.
- When the budget is exceeded, summarise the oldest stable part of the conversation into a compact memory block that preserves goals, key decisions, files touched, validation state, blockers, and unresolved follow-ups.
- Keep the most recent turns unsummarised so the active implementation loop still has full fidelity.
- Persist the generated summary in the chat session state and inject it ahead of the live recent history on subsequent runs.
- Show in the UI when a chat has been compacted and allow the user to inspect or refresh the stored summary.

#### 4.11b — Change stats and diff viewer for edited files

When the agent changes files, Bliss Agent should show what changed in a way that is directly inspectable, similar to the GitHub Copilot chat diff experience.

- After each successful file mutation, show per-file line stats in the UI (`+added` / `-removed`).
- Render a diff viewer for the changed file with added and removed hunks, instead of only plain text summaries.
- Allow the user to switch from the normal file preview to the rendered diff view for the same file.
- Prefer the actual patch or git diff for rendering so the view matches what was really changed on disk.
- Keep the diff viewer scoped to the current run and make it easy to jump from the diff to the file preview.

#### 4.12 — Intent router: explain vs implement

Distinguish requests for explanation from requests for implementation so the agent does not attempt to write files when the user just wants to understand something.

- Add a lightweight classification step at the start of each run: if the message begins with explain, how does, what is, why does, or similar, route to explanation mode (text only, no file tools enabled).
- For all other messages, route to implementation mode (full tool surface available, text-only response flagged as incomplete).

#### 4.13 — Git snapshot and undo

Before any run that modifies files, create a lightweight git snapshot so the user can revert the agent's changes with a single action.

- Before the first `write_file` or `apply_patch` in a run, auto-stash or commit to a named ref (`refs/bliss-agent/pre-run-{timestamp}`).
- Expose an Undo last run button in the UI that resets to this ref.
- Delete snapshots older than 7 days automatically.

#### 4.14 — Per-project memory file (`AGENT.md`)

Allow each project to define conventions, important paths, and preferred commands in a file the agent reads at the start of every run. Equivalent to `CLAUDE.md` in Claude Code.

- On working directory selection, check for `AGENT.md` at the repo root.
- If found, prepend its contents to the system prompt as a project context block.
- Add a Create AGENT.md shortcut in the UI that opens a template in the file viewer.

---

### Nice-to-have — Differentiators

#### 4.15 — Slash commands

Support `/fix`, `/test`, `/explain`, `/commit`, and `/pr` as prefix shortcuts that set a specialised system prompt and route to the appropriate tool subset automatically.

#### 4.16 — Image and screenshot input for visual debugging

Accept image attachments in the chat input. Pass them to the model as vision input so the user can share a screenshot of a rendering issue or error dialog directly.

#### 4.17 — Auto-branch before large changes

When a run is about to modify more than three files, automatically create a git branch named `agent/fix-{timestamp}` before proceeding. Keeps manual work separate from agent changes without requiring the user to think about it.

---

## Recently raised points

### Performance and UI blocking

Status: partially addressed

- `search_text` and file scanning were moved away from blocking synchronous traversal.
- Common heavy folders are now ignored by default (`.venv`, `site-packages`, `node_modules`, etc.).
- `find_files` and `search_text` now run in an isolated child process and report progress while scanning.
- Worker failures now fall back to main-process execution.
- Long-running tool execution can now be stopped without cancelling the whole run.

### File viewer in the UI

Status: completed

- Add a preview panel to inspect file content directly from tool results.
- Enable clicking search matches and file results to open the preview.

### Git and GitHub authentication

Status: partially addressed

- Local git actions do not require remote authentication.
- For GitHub workflows, prefer reusing existing system auth via `gh`, Git Credential Manager, or SSH.
- Do not store GitHub tokens in `localStorage`; use OS keychain/credential storage if app-managed auth is added later.
- The sidebar now reports whether `gh` is installed, authenticated, and pointed at a GitHub origin remote for the selected working directory.
- The settings panel now exposes the same GitHub readiness state with account, repository, and branch details.
- Draft pull request creation, issue creation, issue comments, and PR comments now run through `gh`.
- Issue and PR list/search flows are now available through the GitHub tool surface.
- PR merge-readiness and status checks can now be inspected before merge.
- PR review threads can now be read, replied to, and resolved/unresolved.
- Reviewer requests and PR ready/draft transitions are now modeled in the tool surface.

### Autonomous agent behaviour

Status: planned — see Phase 4 above.

- Agent was outputting code in text instead of calling file tools.
- Agent was asking "how would you like to proceed?" after reading files, instead of acting.
- Root causes: missing tool-use enforcement in system prompt, insufficient iteration ceiling, no read-after-write loop, no automatic error recovery.

---

## Phase 1: Repo Agent

Objective: make the agent reliable inside a local repository.

### Tooling foundation

- `find_files`: discover candidate files quickly.
- `search_text`: search code and config content across the repo.
- `read_file_range`: read only the relevant slice of a file.
- `apply_patch`: make exact-text, local edits instead of overwriting full files.
- `git_status`: inspect working tree state.
- `git_diff`: inspect unstaged or staged changes.
- Keep existing tools for shell execution and full-file reads/writes when necessary.

### Agent workflow

- Ask the model to inspect before editing.
- Prefer search + ranged reads before patching.
- Validate immediately after the first meaningful edit.
- Return a short final summary with changed files and validation status.

### Safety model

- Safe by default for reads and search.
- Confirmation layer for destructive actions later.
- Keep all relative paths anchored to `WORKING DIR`.

## Phase 2: Engineering Workflow

Objective: turn a repo interaction into an end-to-end coding task flow.

### UX additions

- Better model/runtime status.
- File viewer / inspector panel.

### Task flow

- User request
- Repo inspection
- Proposed or implicit plan
- Local patching
- Validation
- Summary of changes and risks

## Phase 3: GitHub Workflow

Objective: connect local repo work with issue and PR workflows.

### First integrations

- Read repository, issue, or PR context.
- Create branch.
- Create commit.
- Draft PR with summary and validation notes.
- Read review comments.

### Implementation options

- Prefer `gh` CLI first for speed.
- Add token-based API integration after the local workflow is stable.

## Immediate backlog

1. Add repo-search tools.
2. Add exact-text patch tool.
3. Add git inspection tools.
4. Surface the new tools in the UI.
5. Add validation-specific tools next (`run_build`, `run_test`, `run_lint`).
6. Add approval and GitHub flows after the local repo loop is stable.

## Current gaps

- Cross-provider fallback is not implemented.

## Current implementation scope

Current implementation snapshot:

- plan file at repo root
- `find_files`
- `search_text`
- `read_file_range`
- `apply_patch`
- `git_status`
- `git_diff`
- `git_create_branch`
- `git_add`
- `git_commit`
- `github_auth_status`
- `github_repo_info`
- `github_issue_list`
- `github_issue_view`
- `github_issue_create`
- `github_issue_edit`
- `github_issue_close`
- `github_issue_reopen`
- `github_issue_comment`
- `github_pr_list`
- `github_pr_view`
- `github_pr_checks`
- `github_pr_review_comments`
- `github_pr_review_threads`
- `github_pr_edit`
- `github_pr_review_submit`
- `github_pr_review_thread_reply`
- `github_pr_review_thread_resolve`
- `github_pr_close`
- `github_pr_reopen`
- `github_pr_comment`
- `github_pr_merge`
- `github_pr_ready`
- `github_pr_create`
- `run_build`
- `run_test`
- `run_lint`
- approval-gated risky tool execution
- per-chat auto-approval controls in the chat UI
- tool-only cancellation for long-running executions
- multi-chat sidebar sessions with chat-local working directory and runtime state
- chat rename/delete controls in the sidebar
- dev port auto-cleanup
- async scan exclusions for large dependency folders
- worker fallback to main-process search execution
- GitHub auth and remote readiness card via `gh`
- Settings tabs for provider, GitHub, and tool inventory
- Provider switching between OpenRouter and Gemini AI Studio
- Provider runtime fallback status in the UI
- Backend discovery guardrails for grounded file mutations