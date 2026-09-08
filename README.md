# Grok Build PR Review — lifecycle extension

Local implementation of App-authored, subscription-backed PR reviews for `szymboot`. **Not yet published or GitHub acceptance-tested:** upstream licensing clearance and deployment remain pending. See [configuration, licensing and limitations](docs/lifecycle.md) and [verification results](docs/verification.md).

The composite action now:

- Rechecks every open finding owned by the configured GitHub App, including outdated threads.
- Requires explicit fix evidence from current source before resolving a thread.
- Preserves discussion and tracks existing findings by stable IDs.
- Creates ordinary PR comments for off-diff findings and updates their Open/Resolved status.
- Submits APPROVE only after complete successful analysis of the current SHA with no open findings; confirmed blockers receive REQUEST_CHANGES, suggestions/uncertainty receive COMMENT.
- Rejects malformed, partial, failed and stale analyses instead of treating them as clean.
- Runs `grok-4.6` with `medium` effort in a source-only Docker environment without GitHub/App credentials; authentication uses the existing shared Grok Build subscription session, with no paid API fallback.

## Configuration

Use Linux with Docker and checkout the event head SHA with `persist-credentials: false`. Generate an installation token with the existing release App secrets using `actions/create-github-app-token`. Retain release permissions on the installation, but request only Contents read and Pull requests write for this token.

Required action inputs:

| Input            | Value                                                       |
| ---------------- | ----------------------------------------------------------- |
| `grok_auth_json` | Existing organization `GROK_AUTH_JSON`; preserve visibility |
| `github_token`   | App installation token                                      |
| `reviewer_login` | Verified App slug plus `[bot]`                              |
| `expected_sha`   | `github.event.pull_request.head.sha`                        |
| `model`          | `grok-4.6` (enforced)                                       |
| `effort`         | `medium` (enforced)                                         |

`pr_number` defaults to the event PR. `max_turns` defaults to 50; `max_diff_kb` to 300. Oversized diffs fail without truncation. `fail_on` defaults to `never`; findings do not fail the workflow unless configured, but infrastructure and validation errors do. `custom_instructions` supplies trusted review preferences. Compatibility inputs `roast_level` and `status_comments` no longer disable professional wording or status visibility.

Outputs are `verdict`, `issue_count`, `bug_count`, `review_url` and `review_event`. On failure `verdict=error`; do not infer approval from a successful CLI exit alone.

Keep draft PR events enabled and skip external fork/Dependabot PRs that cannot access subscription/App secrets. Use the existing repository queue and timeout. Do not enable auto-merge or introduce required checks.

## Development

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
bun run fmt:check
```

`integration/prepare-discord-workflow.py` prepares the `ci/DSC-701` workflow update only after a real fork commit exists. It verifies that SHA on GitHub before writing the pinned workflow. Publication, applying that update, and live subscription/App acceptance runs remain pending.
