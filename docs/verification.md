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

## First live probe and auth ownership regression

The [first lifecycle run](https://github.com/szymboot/discord-bot/actions/runs/34291317713/job/102278259887) used action `a48d935193eb320d98ecbbfe2912ee9f1a99b58f` on PR head `87624e813acc3547fd84441226732dccfd2edfae`. App token creation, context collection and the Docker build succeeded. The CLI stage returned almost immediately and result validation failed. No approval was issued. The original generic error and cleanup discarded the raw CLI failure, so the exact live message cannot be recovered from this run.

A local Linux Docker reproduction with runner-owned (UID 1001) auth directory/file modes 700/600 fails with `Failed to load config: Permission denied (os error 13)`. Container root has no DAC_OVERRIDE capability and cannot read those files. The original empty-root-owned-home smoke test did not exercise this ownership boundary.

The fix assigns the ephemeral auth directory and file to container UID/GID 0 before starting Grok. It preserves 700/600 modes and `--cap-drop ALL`. Fixed-label diagnostics now report the failure phase, CLI exit code and category without printing raw stdout, stderr, API errors or credentials.

Regression validation: 31 Bun tests pass. `permissions-smoke.sh` creates only synthetic `{}` auth inside Linux images: runner-owned auth reproduces EACCES; the same file with corrected ownership reaches the expected Not signed in failure, with no network or secrets. Run it after building the action image:

```sh
docker build --platform linux/amd64 -t grok-review-local:dsc-701 scripts/lifecycle
bash scripts/lifecycle/permissions-smoke.sh grok-review-local:dsc-701
```

The live image installed Grok 1.0.24, while the original local image installed 1.0.13. A new run using the corrected action SHA is required to confirm live session authentication and detect any additional CLI compatibility issue. Re-running the old workflow revision alone retains the old action SHA and cannot apply this fix.

## Native JSON result contract

The [next live run](https://github.com/szymboot/discord-bot/actions/runs/34291919587) reached CLI exit 0 but failed at validate-result; the App-authored status worked and no review was submitted. Investigation found that the parser incorrectly required `type: "result"`. The native `--output-format json` emitter returns `text`, `stopReason`, `sessionId` and `requestId`, without that mandatory discriminator ([upstream HeadlessEmitter::build_json_result](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/src/headless.rs)).

The parser now accepts the native envelope and requires `stopReason: "end_turn"`. Even with exit 0 and a clean-looking review block, max_tokens, max_turn_requests, refusal, cancelled, missing and unknown stop reasons fail closed. Strict report schema, completeness, SHA, assessment and evidence checks remain mandatory.

Safe diagnostics distinguish outer JSON/shape/error/text, stop reason, block count, inner JSON, report schema, analysis completeness/SHA, assessment coverage and fix evidence failures. Schema diagnostics emit only allowlisted field paths and issue codes, never raw values, unknown keys or exception messages. Validation: 36 Bun tests pass, including native-format fixtures and zero-exit truncation/refusal rejection. The exact discarded payload from the previous run is unavailable; the identified contract mismatch is fixed, but live acceptance still needs another pinned run.

## Repair evidence whitespace regression

The live integration subsequently confirmed a [clean App APPROVE](https://github.com/szymboot/discord-bot/actions/runs/34292623377) and [detection of a deliberate zero-default regression with REQUEST_CHANGES](https://github.com/szymboot/discord-bot/actions/runs/34293260042). After the bot agent restored the original source, the [repair run](https://github.com/szymboot/discord-bot/actions/runs/34293542922) failed closed with `validation=fix-evidence-mismatch`.

The evidence schema reused a prose string validator with `.trim()`. That removed leading Go tabs from otherwise exact source excerpts before strict comparison. A regression test first reproduced the corruption (`"\t\treturn 1.0"` became `"return 1.0"`), then passed after giving excerpts a non-transforming validator. Blank excerpts remain invalid. Terminal newlines now match actual source line endings without incorrectly consuming the next line as an additional blank line. The prompt explicitly requires complete lines, preserved whitespace and correct 1-based line numbers.

Validation: 42 tests pass, including parser-to-fix-plan tests for tabs, multiline excerpts, blank lines and trailing spaces. Wrong indentation, content, line numbers, missing terminal newlines, and restored-looking evidence against still-broken source are rejected. Typecheck, formatting and diff checks pass. No fuzzy search, whitespace normalization or relaxation of fix confirmation was added. No discord-bot files were modified during this fix. The discarded live excerpt is unavailable, so this confirms the local validator defect; a new pinned repair run must verify resolution of the existing live finding.
