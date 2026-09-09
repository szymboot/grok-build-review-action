import { PublicationError, publicationStep } from "./publicationDiagnostics.ts";
import { planReview } from "./contract.ts";
import type { Report, Snapshot } from "./contract.ts";
import type { GitHub } from "./github.ts";
import { findingBody } from "./marker.ts";
import { rightSideLines } from "../review/diff/rightSideLines.ts";
import { lineKey } from "../review/diff/lineKey.ts";

export async function publishReview(
    github: Pick<GitHub, "snapshot" | "resolve" | "issue" | "review" | "status">,
    report: Report,
    snapshot: Snapshot,
    diff: string,
    readSource: (file: string) => string,
) {
    const plan = planReview(report, snapshot, readSource);
    const current = await publicationStep("snapshot-refresh", () => github.snapshot());
    if (JSON.stringify(current) !== JSON.stringify(snapshot))
        throw new PublicationError("history-changed", "history-check");
    for (const item of plan.fixed)
        await publicationStep("resolve-finding", () =>
            github.resolve(snapshot.sha, item, plan.assessments.get(item.finding.id)!.explanation),
        );
    const lines = rightSideLines(diff);
    const comments: { path: string; line: number; side: "RIGHT"; body: string }[] = [];
    for (const finding of report.findings) {
        if (finding.line !== null && lines.has(lineKey(finding.file, finding.line))) {
            comments.push({
                path: finding.file,
                line: finding.line,
                side: "RIGHT",
                body: findingBody(finding, snapshot.sha),
            });
        } else await publicationStep("create-off-diff", () => github.issue(snapshot.sha, finding));
    }
    await publicationStep("publish-status", () =>
        github.status(
            snapshot.sha,
            `Grok analysis completed: **${plan.event}** · ${plan.open.length} open finding(s). Review publication follows.\n\n${report.summary}`,
        ),
    );
    const url = await publicationStep("submit-review", () =>
        github.review(snapshot.sha, plan.event, report.summary, comments),
    );
    return { event: plan.event, open: plan.open, url };
}
