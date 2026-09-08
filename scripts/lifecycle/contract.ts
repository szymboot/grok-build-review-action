import { z } from "zod";

const text = z.string().trim().min(1).max(12000);
const file = text.refine(
    (p) => !p.startsWith("/") && !p.split("/").some((s) => s === ".." || s === ".git"),
);
export const FindingSchema = z
    .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,95}$/),
        file,
        line: z.number().int().positive().nullable(),
        severity: z.enum(["bug", "warning", "nit"]),
        blocking: z.boolean(),
        title: text,
        body: text,
    })
    .strict();
export type Finding = z.infer<typeof FindingSchema>;
export const ReportSchema = z
    .object({
        version: z.literal(2),
        head_sha: z.string().regex(/^[a-f0-9]{40}$/),
        complete: z.boolean(),
        summary: text,
        findings: z.array(FindingSchema).max(100),
        assessments: z
            .array(
                z
                    .object({
                        id: text,
                        status: z.enum(["open", "fixed", "uncertain"]),
                        explanation: text,
                        evidence: z
                            .array(
                                z
                                    .object({
                                        file,
                                        line: z.number().int().positive(),
                                        excerpt: text,
                                    })
                                    .strict(),
                            )
                            .max(20),
                    })
                    .strict(),
            )
            .max(1000),
    })
    .strict();
export type Report = z.infer<typeof ReportSchema>;
export type Tracked = {
    finding: Finding;
    body: string;
    target: { kind: "thread"; id: string } | { kind: "comment"; id: number };
};
export type Snapshot = { sha: string; login: string; tracked: Tracked[] };

export function parseReport(output: string, exitCode: string): Report {
    if (exitCode.trim() !== "0") throw new Error("Grok process did not succeed");
    const envelope = JSON.parse(output);
    if (
        envelope.type !== "result" ||
        typeof envelope.text !== "string" ||
        envelope.is_error === true
    ) {
        throw new Error("Grok did not return a successful result envelope");
    }
    const matches = [
        ...envelope.text.matchAll(/<<<GROK_REVIEW>>>\s*([\s\S]*?)\s*<<<END_GROK_REVIEW>>>/g),
    ];
    if (matches.length !== 1) throw new Error("Expected exactly one review block");
    return ReportSchema.parse(JSON.parse(matches[0]![1]!));
}

export function planReview(
    report: Report,
    snapshot: Snapshot,
    readSource: (file: string) => string,
) {
    if (!report.complete || report.head_sha !== snapshot.sha)
        throw new Error("Incomplete or mismatched analysis");
    const previous = new Map(snapshot.tracked.map((item) => [item.finding.id, item]));
    if (previous.size !== snapshot.tracked.length) throw new Error("Duplicate stored finding IDs");
    const assessments = new Map(report.assessments.map((item) => [item.id, item]));
    if (
        assessments.size !== report.assessments.length ||
        assessments.size !== previous.size ||
        [...previous.keys()].some((id) => !assessments.has(id))
    ) {
        throw new Error("Every open finding must be assessed exactly once");
    }
    const ids = new Set<string>();
    for (const finding of report.findings) {
        if (ids.has(finding.id) || previous.has(finding.id))
            throw new Error("Duplicate finding: use an assessment for existing issues");
        ids.add(finding.id);
    }
    const fixed: Tracked[] = [];
    const open: Finding[] = [...report.findings];
    let uncertain = false;
    for (const [id, item] of previous) {
        const assessment = assessments.get(id)!;
        if (assessment.status === "fixed") {
            if (!assessment.evidence.length)
                throw new Error("A fix needs evidence from current source");
            for (const evidence of assessment.evidence) {
                const lines = readSource(evidence.file).split("\n");
                const actual = lines
                    .slice(
                        evidence.line - 1,
                        evidence.line - 1 + evidence.excerpt.split("\n").length,
                    )
                    .join("\n");
                if (actual !== evidence.excerpt)
                    throw new Error("Fix evidence does not match current source");
            }
            fixed.push(item);
        } else {
            open.push(item.finding);
            uncertain ||= assessment.status === "uncertain";
        }
    }
    const confirmedBlocking =
        report.findings.some((item) => item.blocking) ||
        snapshot.tracked.some(
            (item) => item.finding.blocking && assessments.get(item.finding.id)!.status === "open",
        );
    const event = confirmedBlocking
        ? "REQUEST_CHANGES"
        : open.length || uncertain
          ? "COMMENT"
          : "APPROVE";
    return { fixed, open, event, assessments } as const;
}
