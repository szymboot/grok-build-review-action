# Verification — 2026-09-09

This is a local implementation, not a completed rollout. No new action commit was published and discord-bot PR #807's workflow was not updated to this implementation.

## Local tests

`bun test`: 28 passing tests (18 lifecycle tests and 10 upstream tests), 0 failures. The lifecycle tests use mocked GitHub adapters/API responses; they do not prove App permissions or GitHub's live review state transitions.

| Scenario                                                                     | Local result | Live GitHub lifecycle run        |
| ---------------------------------------------------------------------------- | ------------ | -------------------------------- |
| Bug → inline finding + REQUEST_CHANGES                                       | Passed       | Pending                          |
| Push without fix, including moved/outdated line → remains open, no duplicate | Passed       | Pending                          |
| Verified fix → thread resolution + APPROVE                                   | Passed       | Pending                          |
| Clean PR → APPROVE                                                           | Passed       | Pending                          |
| Uncertain fix → remains open, COMMENT                                        | Passed       | Pending                          |
| Failed login/nonzero exit, malformed/partial output → no approval            | Passed       | Pending                          |
| Foreign threads/comments and changed SHA/history → no unauthorized mutations | Passed       | Pending                          |
| Fixed off-diff issue → status update preserving original text                | Passed       | Pending                          |
| Publication-time SHA race → dismiss this run's stale review                  | Passed       | Pending                          |
| New head → dismiss only this App's older approvals                           | Passed       | Pending                          |
| GraphQL bot login normalization and forged foreign markers                   | Passed       | Read-only format check confirmed |

Additional local checks:

- TypeScript `bun run typecheck`: passed.
- `bun run fmt:check`: passed.
- `git diff --check`: passed.
- Composite action YAML parsing and `bash -n` on all its run scripts: passed.
- Tracked-source export: byte-for-byte match for a HEAD blob; no `.git` exported.
- Linux amd64 Docker build: passed; installed Grok `1.0.13 (5e9a58528b76)`.
- Docker CLI execution with an empty auth directory and no network: exited 1 with a JSON `type:error` authentication failure. The command accepted the configured tool/model/effort/isolation flags. No real session or API key was used.
- Workflow generator: tested against existing fork baseline SHA `eded30018cdee4e83dfca14d18f292b860c30cdd` only in a temporary file, never deployed. This does not pin the new implementation.
- `actionlint` on the generated temporary workflow: its only diagnostic was unsupported `concurrency.queue`; it passed when that exact diagnostic was excluded. Existing `queue: max` was retained, not introduced here.
- discord-bot `make lint`: not run because no discord-bot checkout files were edited. Its repository checks remain required when the integration update is applied.

## Confirmed GitHub operations

- Existing public szymboot fork and upstream parent confirmed through repository metadata.
- Upstream recursive tree contains no license file; license API returned 404; fork license is null.
- Organization App installation metadata confirmed `szymboot`, App ID `3570191`, installation `128741233`, all repositories, Contents write and Pull requests write.
- Secret metadata confirmed shared `GROK_AUTH_JSON` visibility `all`, release App secrets visibility `private`. No values were read or changed.
- POST requested reviewer `szymboot[bot]` on [PR #807](https://github.com/szymboot/discord-bot/pull/807) returned no requested reviewers; a subsequent GET confirmed empty users/teams. No reviewer was added.
- GraphQL reports the existing `github-actions` author as `Bot` without REST's `[bot]` suffix. The ownership code accounts for that representation.
- The existing upstream integration has an earlier [successful status-comment run](https://github.com/szymboot/discord-bot/actions/runs/34288548644). This is not a test of the new lifecycle or release App signing.

## Pending acceptance and release

Obtain upstream distribution permission; publish a reviewed ticket-branch commit; generate the exact-SHA discord-bot update; validate the real App token; run all lifecycle scenarios above on a disposable PR with the App and shared subscription. Record each head SHA, run URL, review author/state, thread/comment ID and final status. In particular verify success-envelope compatibility, discussion resolution, GitHub superseding REQUEST_CHANGES with APPROVE, stale-review dismissal rights, and two separate runner executions. Keep release automation, organization-secret visibility, optional checks and auto-merge settings unchanged.

See [configuration and residual limitations](lifecycle.md), including semantic evidence/deduplication dependence on the model and GitHub's lack of atomic SHA-conditional thread mutation.
