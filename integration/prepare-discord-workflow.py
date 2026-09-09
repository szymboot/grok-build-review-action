"""Materialize a workflow pinned to a real published fork commit after licensing clearance.

Usage: python3 integration/prepare-discord-workflow.py FORK_SHA original.yml output.yml
Fetch original.yml from ci/DSC-701 in szymboot/discord-bot before running.
"""
import pathlib
import re
import subprocess
import sys

sha, original, output = sys.argv[1:]
if not re.fullmatch(r"[a-f0-9]{40}", sha):
    raise SystemExit("A full 40-character fork SHA is required")
resolved = subprocess.check_output(["gh", "api", f"repos/szymboot/grok-build-review-action/commits/{sha}", "--jq", ".sha"], text=True).strip()
if resolved != sha:
    raise SystemExit("Commit was not verified in the fork")
source = pathlib.Path(original).read_text()
old = "0xr3ngar/grok-build-review-action@eded30018cdee4e83dfca14d18f292b860c30cdd # v1.0.2"
if source.count(old) != 1 or source.count("github_token: ${{ github.token }}") != 1:
    raise SystemExit("Workflow changed; review the new version before applying")
source = source.replace("  pull-requests: write", "  pull-requests: read", 1)
source = source.replace("    # Temporarily include draft PRs while validating the reviewer.", "    # Include drafts; a new head always requires a new review.")
source = source.replace("      - name: Review with Grok 4.6", """      - name: Create reviewer App token
        id: reviewer_app
        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3
        with:
          app-id: ${{ secrets.RELEASE_BOT_APP_ID }}
          private-key: ${{ secrets.RELEASE_BOT_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
          repositories: ${{ github.event.repository.name }}
          # GitHub resolveReviewThread also requires Contents write.
          permission-contents: write
          permission-pull-requests: write

      - name: Review with Grok 4.6""")
source = source.replace(old, f"szymboot/grok-build-review-action@{sha}")
source = source.replace("          github_token: ${{ github.token }}", """          github_token: ${{ steps.reviewer_app.outputs.token }}
          reviewer_login: ${{ steps.reviewer_app.outputs.app-slug }}[bot]
          expected_sha: ${{ github.event.pull_request.head.sha }}""")
pathlib.Path(output).write_text(source)
