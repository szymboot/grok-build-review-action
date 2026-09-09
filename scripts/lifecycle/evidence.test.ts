import { expect, test } from "bun:test";
import { parseReport, planReview } from "./contract.ts";
import type { Snapshot } from "./contract.ts";

const sha = "a".repeat(40);
const state: Snapshot = {
    sha,
    login: "szymboot[bot]",
    tracked: [
        {
            finding: {
                id: "fallback-zero",
                file: "fallback.go",
                line: 3,
                severity: "bug",
                blocking: true,
                title: "Wrong default",
                body: "Missing entries must use the neutral multiplier.",
            },
            body: "Original discussion",
            target: { kind: "thread", id: "thread" },
        },
    ],
};
const source =
    "func fallback(ok bool) float64 {\n\tif !ok {\n\t\treturn 1.0\n\t}\n\treturn 2.0\n}\n";
function parseEvidence(excerpt: string, line = 3) {
    const report = {
        version: 2,
        head_sha: sha,
        complete: true,
        summary: "The neutral default is restored.",
        findings: [],
        assessments: [
            {
                id: "fallback-zero",
                status: "fixed",
                explanation: "Missing entries now return one instead of zero.",
                evidence: [{ file: "fallback.go", line, excerpt }],
            },
        ],
    };
    return parseReport(
        JSON.stringify({
            stopReason: "end_turn",
            text: `<<<GROK_REVIEW>>>\n${JSON.stringify(report)}\n<<<END_GROK_REVIEW>>>`,
        }),
        "0",
    );
}

test("parser preserves Go tabs so exact fix evidence can resolve and approve", () => {
    const report = parseEvidence("\t\treturn 1.0");
    expect(report.assessments[0]!.evidence[0]!.excerpt).toBe("\t\treturn 1.0");
    const plan = planReview(report, state, () => source);
    expect(plan.fixed).toEqual(state.tracked);
    expect(plan.event).toBe("APPROVE");
});

test("multi-line evidence preserves its leading indentation and final newline", () => {
    const excerpt = "\tif !ok {\n\t\treturn 1.0\n\t}\n";
    const report = parseEvidence(excerpt, 2);
    expect(report.assessments[0]!.evidence[0]!.excerpt).toBe(excerpt);
    expect(planReview(report, state, () => source).event).toBe("APPROVE");
    expect(() =>
        planReview(report, state, () => source.split("\n").slice(0, 4).join("\n")),
    ).toThrow("fix-evidence-mismatch");
});

test("leading blank lines and trailing spaces are preserved rather than trimmed", () => {
    const excerpt = "\n    return 1.0  ";
    const report = parseEvidence(excerpt, 1);
    expect(report.assessments[0]!.evidence[0]!.excerpt).toBe(excerpt);
    expect(planReview(report, state, () => excerpt).event).toBe("APPROVE");
});

test("missing or wrong indentation never becomes acceptable through normalization", () => {
    for (const excerpt of ["return 1.0", "        return 1.0", "\treturn 1.0", "\t\treturn 1.0 "]) {
        expect(() => planReview(parseEvidence(excerpt), state, () => source)).toThrow(
            "fix-evidence-mismatch",
        );
    }
});

test("wrong content, wrong line, and restored-looking evidence for an unfixed source are rejected", () => {
    expect(() => planReview(parseEvidence("\t\treturn 0.0"), state, () => source)).toThrow(
        "fix-evidence-mismatch",
    );
    expect(() => planReview(parseEvidence("\t\treturn 1.0", 4), state, () => source)).toThrow(
        "fix-evidence-mismatch",
    );
    expect(() => planReview(parseEvidence("\t\treturn 1.0", 100), state, () => source)).toThrow(
        "fix-evidence-mismatch",
    );
    expect(() =>
        planReview(parseEvidence("\t\treturn 1.0"), state, () => source.replace("1.0", "0.0")),
    ).toThrow("fix-evidence-mismatch");
});

test("blank evidence remains invalid", () => {
    for (const excerpt of ["", " ", "\t\n\r "])
        expect(() => parseEvidence(excerpt)).toThrow("review-schema");
});
