# Subscription PR review lifecycle (local implementation)

Publication is pending upstream licensing clearance. This checkout is based on upstream `eded30018cdee4e83dfca14d18f292b860c30cdd`. Do not describe this implementation as deployed or GitHub acceptance-tested. No new fork commit has been published or pinned in discord-bot.

## GitHub App configuration

Use the existing `RELEASE_BOT_APP_ID` and `RELEASE_BOT_PRIVATE_KEY` only in `actions/create-github-app-token`, outside the model container. Pass its installation token as `github_token`, `${{ steps.reviewer_app.outputs.app-slug }}[bot]` as `reviewer_login`, and the event PR head SHA as `expected_sha`. The runtime verifies an installation token and the GraphQL viewer identity before reading or changing tracked findings.

Required installation **and review-token** permissions: Contents write and Pull requests write (the latter also permits PR issue comments). Scope the token to the reviewed repository. GitHub gates `resolveReviewThread` on Contents write for installation tokens: our Contents-read token received FORBIDDEN despite owning the finding and successfully submitting REQUEST_CHANGES. This matches [the reported reproduction in github/gh-aw](https://github.com/github/gh-aw/issues/35726). The release App already has both write permissions, so no installation/secret change is needed. The token remains outside the model container, and the action does not use it to modify source files. Do not reduce the installation's release permissions, change its repository selection, or edit release workflows. The action does not need Checks write: the existing workflow check and the App's status comment/review provide visibility. Do not add required checks or auto-merge.

On 2026-09-09, GitHub reported App `szymboot`, App ID `3570191`, installation `128741233`, repository selection `all`, Contents write, Pull requests write and Metadata read. Organization secret metadata reports `RELEASE_BOT_APP_ID` and `RELEASE_BOT_PRIVATE_KEY` as `private`; these are available to private discord-bot, not the public action fork. Secret values were not read. Matching those secret values to the installation remains a live token-generation check.

A live REST request to add `szymboot[bot]` to PR #807's requested reviewers returned an empty requested-reviewer list; a separate GET also returned no users or teams. Therefore this App could not be added by the tested API path. This is not a prerequisite for App-authored reviews. Do not claim universal support or failure for all GitHub Apps based on this one attempt. [GitHub documents user/team review requests](https://docs.github.com/en/rest/pulls/review-requests).

## Review decisions and history

The model receives every open, marked finding authored by this App, including the full inline discussion, independently of the current diff and outdated status. It must assess each exactly once. Missing, extra or duplicate assessments stop publication. A stable finding ID describes the symbol and root cause, not a line number. Existing IDs cannot be emitted again as new findings; moved lines do not close findings. Semantic matching across paraphrased root causes still depends on the model obeying the explicit deduplication contract.

Fixed findings require an explanation and exact excerpts checked against current source files. This validates the location/content of evidence; the model performs the semantic assessment of whether it proves a fix. Uncertain findings remain open. Deletions without a provable replacement/call-site can require manual resolution. No comments are deleted. Off-diff findings are ordinary PR issue comments with an Open/Resolved status; resolving one preserves its original text and appends the fix explanation and SHA.

The model cannot select mutation targets: only IDs collected from App-owned comments are used, and ownership is fetched again before a resolution. Other bots, human threads and legacy github-actions comments are untouched. Unmarked open threads by the same App fail closed and require manual migration; this avoids approving over unknown same-App findings. The legacy github-actions thread on #807 is not owned by the new App and will need human handling.

- APPROVE: complete, valid successful analysis, no open findings, exact current head SHA.
- REQUEST_CHANGES: at least one confirmed blocking finding, new or still open.
- COMMENT: only nonblocking suggestions or uncertain findings remain.
- Failed login, nonzero exit, malformed or multiple output blocks, missing fields, omitted assessments, unavailable history, stale head, truncated diff, or unverified fix evidence: fail closed.

Before publishing, the action fetches the full history again and requires the snapshot to match. Before each mutation it checks the head. Reviews carry `commit_id`. Old App approvals for other SHAs are dismissed at collection time. A successful later APPROVE by the same App supersedes its REQUEST_CHANGES through GitHub review state; the older review remains in history. This interaction still requires live acceptance testing with the installation.

GitHub does not provide a head-SHA compare-and-swap option for thread resolution or issue-comment edits. A push in the short gap between GET and mutation cannot be eliminated client-side. A review publication is followed by another head check, and a stale approval/request-changes is dismissed if possible. API/network failure during that cleanup can require operator intervention. This is not a guarantee of atomic publication; no new branch rules are enabled by this action. A new push whose workflow never starts likewise cannot be handled by this action.

## Model isolation and session

Grok runs in Docker with only a source snapshot, prompt, and the Grok subscription session mounted. No Git metadata, GitHub token, App key, runner command files or host environment is passed into it. Its available tools are read_file, grep and list_dir; web tools and subagents are disabled. The CLI starts in /review, outside the source tree, so source-controlled project configuration, MCP commands and startup hooks are not loaded as its working-directory configuration. Source export uses Git blobs, not builds, hooks, filters, repository scripts or PR-controlled archive rules. Symlinks/submodules and snapshots above 100 MiB fail closed. Source and prompt mounts are read-only. No paid API fallback is configured; model and effort are enforced as `grok-4.6` and `medium`.

The subscription auth file is available inside the CLI container because the CLI must authenticate; the isolation guarantee concerns GitHub/App credentials, not hiding the subscription credential from its own CLI. Never put App/GitHub credentials in source or custom instructions. Do not upload raw CLI output or stderr as artifacts.

Keep the organization `GROK_AUTH_JSON` visibility and shared-session arrangement unchanged. It currently has visibility `all`. Refreshed auth is ephemeral and is removed after the job; cross-repository concurrent refresh remains a known limitation. There is no new session manager. Repository-local queued concurrency remains in the discord-bot workflow. Token refresh/replacement must preserve organization-secret visibility.

Docker and Linux are required. The upstream Grok installer and base/runtime packages remain network-installed, not fully immutable. The action SHA pin alone does not pin them. A failed image build or incompatible CLI result format fails the job. Live CLI envelope compatibility and subscription access need validation before rollout.

## Applying the discord-bot update

After upstream permission is established, publish the reviewed action commit on a ticket branch (`feat/DSC-701`, English Conventional Commit/PR titles with the required ticket suffix on the first commit/PR). Then fetch the current workflow from `ci/DSC-701` and run:

```sh
python3 integration/prepare-discord-workflow.py FULL_PUBLISHED_FORK_SHA original.yml grok-pr-review.yml
```

The helper requires an existing exact 40-character fork commit, refuses an unexpected source workflow, retains draft triggers/session concurrency and all model settings, adds an App token scoped to the target repository with Contents write and Pull requests write, and changes the action reference to the real fork SHA. It does not fabricate a placeholder commit or modify discord-bot remotely. Apply the result to `.github/workflows/grok-pr-review.yml` on `ci/DSC-701`, update its README limitations, follow that repository's AGENTS.md/review skill and run its required checks. This integration step remains pending; no deployed workflow was changed here.

## License gate

Upstream has no license file in the recursive tree, no license declaration in README/package metadata, and the GitHub license endpoint returns 404. The existing szymboot fork reports `license: null`. Public GitHub hosting permits viewing/forking but does not itself supply a license to distribute modified derivatives. Obtain an explicit license or permission before publishing this modified fork. [GitHub licensing guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository).
