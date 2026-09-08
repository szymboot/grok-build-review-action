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
    const current = await github.snapshot();
    if (JSON.stringify(current) !== JSON.stringify(snapshot))
        throw new Error("PR history changed during analysis; rerun required");
    for (const item of plan.fixed)
        await github.resolve(
            snapshot.sha,
            item,
            plan.assessments.get(item.finding.id)!.explanation,
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
        } else await github.issue(snapshot.sha, finding);
    }
    await github.status(
        snapshot.sha,
        `Grok analysis completed: **${plan.event}** · ${plan.open.length} open finding(s). Review publication follows.\n\n${report.summary}`,
    );
    const url = await github.review(snapshot.sha, plan.event, report.summary, comments);
    return { event: plan.event, open: plan.open, url };
}
