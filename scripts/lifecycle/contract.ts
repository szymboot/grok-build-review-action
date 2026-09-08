import { z } from "zod";
import { ReviewValidationError, schemaDiagnostic } from "./diagnostics.ts";

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
    if (exitCode.trim() !== "0") throw new ReviewValidationError("cli-exit");
    let envelope: unknown;
    try {
        envelope = JSON.parse(output);
    } catch {
        throw new ReviewValidationError("envelope-json");
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
        throw new ReviewValidationError("envelope-shape");
    const value = envelope as Record<string, unknown>;
    // Native JSON output has text + stopReason, not a mandatory type:"result" discriminator.
    // Source: xai-org/grok-build, headless.rs, HeadlessEmitter::build_json_result.
    if (
        (value.type !== undefined && value.type !== "result") ||
        (value.is_error !== undefined && value.is_error !== false)
    )
        throw new ReviewValidationError("envelope-error");
    if (typeof value.text !== "string") throw new ReviewValidationError("envelope-text");
    if (value.stopReason !== "end_turn") {
        const reasons = ["max_tokens", "max_turn_requests", "refusal", "cancelled"];
        const reason =
            typeof value.stopReason === "string" && reasons.includes(value.stopReason)
                ? value.stopReason
                : value.stopReason === undefined
                  ? "missing"
                  : "unknown";
        throw new ReviewValidationError("stop-reason", `stop_reason=${reason}`);
    }
    const matches = [
        ...value.text.matchAll(/<<<GROK_REVIEW>>>\s*([\s\S]*?)\s*<<<END_GROK_REVIEW>>>/g),
    ];
    if (matches.length !== 1)
        throw new ReviewValidationError(
            "review-block-count",
            `blocks=${Math.min(matches.length, 2)}`,
        );
    let json: unknown;
    try {
        json = JSON.parse(matches[0]![1]!);
    } catch {
        throw new ReviewValidationError("review-json");
    }
    const result = ReportSchema.safeParse(json);
    if (!result.success)
        throw new ReviewValidationError(
            "review-schema",
            `schema=${schemaDiagnostic(result.error.issues)}`,
        );
    return result.data;
}

export function planReview(
    report: Report,
    snapshot: Snapshot,
    readSource: (file: string) => string,
) {
    if (!report.complete) throw new ReviewValidationError("analysis-incomplete");
    if (report.head_sha !== snapshot.sha) throw new ReviewValidationError("sha-mismatch");
    const previous = new Map(snapshot.tracked.map((item) => [item.finding.id, item]));
    if (previous.size !== snapshot.tracked.length)
        throw new ReviewValidationError("stored-duplicates");
    const assessments = new Map(report.assessments.map((item) => [item.id, item]));
    if (
        assessments.size !== report.assessments.length ||
        assessments.size !== previous.size ||
        [...previous.keys()].some((id) => !assessments.has(id))
    ) {
        throw new ReviewValidationError("assessment-coverage");
    }
    const ids = new Set<string>();
    for (const finding of report.findings) {
        if (ids.has(finding.id) || previous.has(finding.id))
            throw new ReviewValidationError("finding-duplicate");
        ids.add(finding.id);
    }
    const fixed: Tracked[] = [];
    const open: Finding[] = [...report.findings];
    let uncertain = false;
    for (const [id, item] of previous) {
        const assessment = assessments.get(id)!;
        if (assessment.status === "fixed") {
            if (!assessment.evidence.length)
                throw new ReviewValidationError("fix-evidence-missing");
            for (const evidence of assessment.evidence) {
                let source: string;
                try {
                    source = readSource(evidence.file);
                } catch {
                    throw new ReviewValidationError("fix-evidence-unavailable");
                }
                const lines = source.split("\n");
                const actual = lines
                    .slice(
                        evidence.line - 1,
                        evidence.line - 1 + evidence.excerpt.split("\n").length,
                    )
                    .join("\n");
                if (actual !== evidence.excerpt)
                    throw new ReviewValidationError("fix-evidence-mismatch");
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
