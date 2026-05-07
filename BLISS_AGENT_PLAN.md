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

### In progress

- Backend-side persisted approval policy instead of renderer-only session state.

### Newly completed

- Provider settings now allow switching between the current OpenRouter fallback chain and Gemini AI Studio.
- GitHub auth-required cards can now launch browser login through `gh auth login --web` and auto-refresh status on return.
- Global secondary text colors were lifted for better readability.
- Existing-file grounding now requires a real file read before patching.
- Long-running tool execution can now be stopped independently of the full run.
- Multi-chat sidebar sessions now preserve chat-specific working directories and runtime state.

### Planned

- Remaining GitHub write flows via `gh` first, then API/token support if needed.
- Richer model/provider controls and optional cross-provider fallback.

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
- Remaining work: deeper GitHub review/merge/edit coverage beyond the current `gh` flows.

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

- Approval policies are only tracked in the renderer for the current chat; they are not yet modeled explicitly in the backend.
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
- `github_issue_view`
- `github_issue_create`
- `github_issue_edit`
- `github_issue_close`
- `github_issue_reopen`
- `github_issue_comment`
- `github_pr_view`
- `github_pr_review_comments`
- `github_pr_edit`
- `github_pr_review_submit`
- `github_pr_close`
- `github_pr_reopen`
- `github_pr_comment`
- `github_pr_merge`
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