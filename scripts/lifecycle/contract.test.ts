import { expect, test } from "bun:test";
import { parseReport, planReview } from "./contract.ts";
import { validationDiagnostic } from "./diagnostics.ts";

const report = {
    version: 2 as const,
    head_sha: "a".repeat(40),
    complete: true,
    summary: "Clean",
    findings: [],
    assessments: [],
};
const block = (value: unknown) =>
    `<<<GROK_REVIEW>>>\n${JSON.stringify(value)}\n<<<END_GROK_REVIEW>>>`;
const output = (text: string, stopReason: unknown = "end_turn") =>
    JSON.stringify({ text, stopReason, sessionId: "synthetic", requestId: "synthetic" });
function failure(value: string): string {
    try {
        parseReport(value, "0");
        throw new Error("Expected rejection");
    } catch (error) {
        const label = validationDiagnostic(error);
        expect(label).not.toBe("");
        return label;
    }
}

test("native Grok JSON envelope without type parses and permits a complete clean review", () => {
    const parsed = parseReport(output(block(report)), "0");
    expect(parsed).toEqual(report);
    expect(
        planReview(parsed, { sha: report.head_sha, login: "szymboot[bot]", tracked: [] }, () => "")
            .event,
    ).toBe("APPROVE");
});

test("valid-looking clean blocks cannot bypass non-success stop reasons", () => {
    for (const stop of ["max_tokens", "max_turn_requests", "refusal", "cancelled"]) {
        expect(failure(output(block(report), stop))).toBe(
            `validation=stop-reason; stop_reason=${stop}`,
        );
    }
    expect(failure(output(block(report), "private-token"))).toBe(
        "validation=stop-reason; stop_reason=unknown",
    );
    expect(failure(JSON.stringify({ text: block(report) }))).toBe(
        "validation=stop-reason; stop_reason=missing",
    );
});

test("JSON, envelope, block and schema failures have distinct safe labels", () => {
    expect(failure("private-token")).toBe("validation=envelope-json");
    expect(failure("null")).toBe("validation=envelope-shape");
    expect(
        failure(JSON.stringify({ type: "error", text: block(report), stopReason: "end_turn" })),
    ).toBe("validation=envelope-error");
    expect(failure(JSON.stringify({ stopReason: "end_turn" }))).toBe("validation=envelope-text");
    expect(failure(output("no block private-token"))).toBe(
        "validation=review-block-count; blocks=0",
    );
    expect(failure(output(block(report).repeat(2)))).toBe(
        "validation=review-block-count; blocks=2",
    );
    expect(failure(output("<<<GROK_REVIEW>>>{private-token}<<<END_GROK_REVIEW>>>"))).toBe(
        "validation=review-json",
    );
    expect(failure(output(block({ ...report, complete: "private-token" })))).toBe(
        "validation=review-schema; schema=complete:invalid_type",
    );
    expect(failure(output(block({ ...report, "private-token": "secret" })))).toBe(
        "validation=review-schema; schema=root:unrecognized_keys",
    );
});

test("an explicit CLI error cannot pass even with exit zero and an end-turn clean block", () => {
    expect(
        failure(JSON.stringify({ text: block(report), stopReason: "end_turn", is_error: true })),
    ).toBe("validation=envelope-error");
});

test("missing or mismatched fix evidence has a distinct validation category", () => {
    const finding = {
        id: "existing-bug",
        file: "a.ts",
        line: 1,
        severity: "bug" as const,
        blocking: true,
        title: "Bug",
        body: "Bug",
    };
    const state = {
        sha: report.head_sha,
        login: "szymboot[bot]",
        tracked: [{ finding, body: "original", target: { kind: "thread" as const, id: "thread" } }],
    };
    const fixed = {
        ...report,
        assessments: [
            {
                id: finding.id,
                status: "fixed" as const,
                explanation: "Fixed",
                evidence: [{ file: "a.ts", line: 1, excerpt: "expected" }],
            },
        ],
    };
    try {
        planReview(fixed, state, () => "actual");
        throw new Error("Expected rejection");
    } catch (error) {
        expect(validationDiagnostic(error)).toBe("validation=fix-evidence-mismatch");
    }
    try {
        planReview(fixed, state, () => {
            throw new Error("private path");
        });
        throw new Error("Expected rejection");
    } catch (error) {
        expect(validationDiagnostic(error)).toBe("validation=fix-evidence-unavailable");
    }
});
