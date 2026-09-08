import { describe, expect, test } from "bun:test";
import { parseReport, planReview, ReportSchema } from "./contract.ts";
import type { Finding, Report, Snapshot, Tracked } from "./contract.ts";
import { publishReview } from "./publish.ts";
import { findingBody, readFinding, resolvedBody } from "./marker.ts";
import { GitHub } from "./github.ts";

const sha = "a".repeat(40);
const bug: Finding = {
    id: "divide-zero",
    file: "a.ts",
    line: 1,
    severity: "bug",
    blocking: true,
    title: "Division by zero",
    body: "The zero divisor is not checked.",
};
const report = (changes: Partial<Report> = {}): Report => ({
    version: 2,
    head_sha: sha,
    complete: true,
    summary: "Review completed.",
    findings: [],
    assessments: [],
    ...changes,
});
const item: Tracked = {
    finding: bug,
    body: findingBody(bug, sha),
    target: { kind: "thread", id: "thread1" },
};
const snapshot = (tracked: Tracked[] = []): Snapshot => ({ sha, login: "szymboot[bot]", tracked });
const read = () => "if (divisor === 0) return null;";
const fixed: Report["assessments"][number] = {
    id: bug.id,
    status: "fixed",
    explanation: "The zero case now returns before division.",
    evidence: [{ file: "a.ts", line: 1, excerpt: read() }],
};
const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
const envelope = (value: unknown) =>
    JSON.stringify({
        type: "result",
        text: `<<<GROK_REVIEW>>>\n${JSON.stringify(value)}\n<<<END_GROK_REVIEW>>>`,
    });
function fake(state: Snapshot) {
    const operations: { kind: string; args: unknown[] }[] = [];
    return {
        operations,
        snapshot: async () => state,
        resolve: async (...args: unknown[]) => {
            operations.push({ kind: "resolve", args });
        },
        issue: async (...args: unknown[]) => {
            operations.push({ kind: "issue", args });
        },
        status: async (...args: unknown[]) => {
            operations.push({ kind: "status", args });
        },
        review: async (...args: unknown[]) => {
            operations.push({ kind: "review", args });
            return "https://github.com/review/1";
        },
    };
}

describe("fail-closed result validation", () => {
    test("clean complete result approves", () => {
        expect(planReview(parseReport(envelope(report()), "0"), snapshot(), read).event).toBe(
            "APPROVE",
        );
    });
    test("nonzero exit, auth failure, malformed envelope and duplicate blocks never parse", () => {
        for (const code of ["1", "137", "", "null"])
            expect(() => parseReport(envelope(report()), code)).toThrow();
        for (const value of [
            "invalid",
            JSON.stringify({ type: "error", message: "limit" }),
            JSON.stringify({ type: "result", is_error: true, text: "ignored" }),
            JSON.stringify({ type: "result", text: JSON.parse(envelope(report())).text.repeat(2) }),
        ])
            expect(() => parseReport(value, "0")).toThrow();
    });
    test("missing findings and malformed findings do not silently become clean", () => {
        for (const value of [
            { version: 2, summary: "Fine" },
            report({ findings: [{} as Finding] }),
            { ...report(), extra: true },
        ])
            expect(() => parseReport(envelope(value), "0")).toThrow();
    });
    test("incomplete, stale, omitted assessments, duplicate IDs and forged evidence fail", () => {
        expect(() => planReview(report({ complete: false }), snapshot(), read)).toThrow();
        expect(() => planReview(report({ head_sha: "b".repeat(40) }), snapshot(), read)).toThrow();
        expect(() => planReview(report(), snapshot([item]), read)).toThrow();
        expect(() =>
            planReview(report({ assessments: [fixed, fixed] }), snapshot([item]), read),
        ).toThrow();
        expect(() =>
            planReview(
                report({ assessments: [{ ...fixed, evidence: [] }] }),
                snapshot([item]),
                read,
            ),
        ).toThrow();
        expect(() =>
            planReview(report({ assessments: [fixed] }), snapshot([item]), () => "not fixed"),
        ).toThrow();
        expect(() => planReview(report({ findings: [bug, bug] }), snapshot(), read)).toThrow();
    });
    test("uncertainty stays open without approval and suggestions use COMMENT", () => {
        const plan = planReview(
            report({ assessments: [{ ...fixed, status: "uncertain", evidence: [] }] }),
            snapshot([item]),
            read,
        );
        expect(plan.event).toBe("COMMENT");
        expect(plan.fixed).toEqual([]);
        expect(plan.open).toEqual([bug]);
        expect(
            planReview(report({ findings: [{ ...bug, blocking: false }] }), snapshot(), read).event,
        ).toBe("COMMENT");
    });
    test("unsafe paths and coercion are rejected", () => {
        for (const file of ["/etc/passwd", "../auth.json", "src/../../auth.json", ".git/config"])
            expect(ReportSchema.safeParse(report({ findings: [{ ...bug, file }] })).success).toBe(
                false,
            );
        expect(
            ReportSchema.safeParse(
                report({ findings: [{ ...bug, line: "1" as unknown as number }] }),
            ).success,
        ).toBe(false);
    });
});

describe("publication lifecycle with mocked GitHub", () => {
    test("bug -> inline App review and REQUEST_CHANGES", async () => {
        const api = fake(snapshot());
        const result = await publishReview(
            api,
            report({ findings: [bug] }),
            snapshot(),
            diff,
            read,
        );
        expect(result.event).toBe("REQUEST_CHANGES");
        const review = api.operations.find((o) => o.kind === "review")!;
        expect(review.args[0]).toBe(sha);
        expect(review.args[1]).toBe("REQUEST_CHANGES");
        expect(readFinding((review.args[3] as { body: string }[])[0]!.body)).toEqual(bug);
        expect(api.operations.some((o) => o.kind === "issue")).toBe(false);
    });
    test("push without fix, including a moved/outdated line, retains one finding", async () => {
        const state = snapshot([item]);
        const api = fake(state);
        await publishReview(
            api,
            report({ assessments: [{ ...fixed, status: "open", evidence: [] }] }),
            state,
            "",
            read,
        );
        expect(api.operations.map((o) => o.kind)).toEqual(["status", "review"]);
        expect(api.operations[1]!.args[1]).toBe("REQUEST_CHANGES");
        expect(api.operations[1]!.args[3]).toEqual([]);
    });
    test("verified fix resolves thread then approves current SHA", async () => {
        const state = snapshot([item]);
        const api = fake(state);
        const result = await publishReview(
            api,
            report({ assessments: [fixed] }),
            state,
            diff,
            read,
        );
        expect(result.event).toBe("APPROVE");
        expect(api.operations.map((o) => o.kind)).toEqual(["resolve", "status", "review"]);
    });
    test("clean PR approves", async () => {
        const api = fake(snapshot());
        expect((await publishReview(api, report(), snapshot(), diff, read)).event).toBe("APPROVE");
    });
    test("off-diff finding is an issue comment; fixed comment is updated preserving history", async () => {
        const api = fake(snapshot());
        await publishReview(api, report({ findings: [bug] }), snapshot(), "", read);
        expect(api.operations[0]!.kind).toBe("issue");
        const comment = { ...item, target: { kind: "comment" as const, id: 42 } };
        const state = snapshot([comment]);
        const fixedApi = fake(state);
        await publishReview(fixedApi, report({ assessments: [fixed] }), state, diff, read);
        expect(fixedApi.operations[0]!.args[1]).toEqual(comment);
        const body = resolvedBody(item.body, sha, fixed.explanation);
        expect(body).toContain(bug.body);
        expect(body).toContain("**Resolved ·");
        expect(readFinding(body)).toEqual(bug);
    });
    test("changed history or SHA causes zero mutations", async () => {
        for (const state of [{ ...snapshot(), sha: "b".repeat(40) }, snapshot([item])]) {
            const api = fake(state);
            await expect(publishReview(api, report(), snapshot(), diff, read)).rejects.toThrow();
            expect(api.operations).toEqual([]);
        }
    });
    test("resolution/publication failure never reaches approval", async () => {
        const state = snapshot([item]);
        const api = fake(state);
        api.resolve = async () => {
            throw new Error("403");
        };
        await expect(
            publishReview(api, report({ assessments: [fixed] }), state, diff, read),
        ).rejects.toThrow();
        expect(api.operations).toEqual([]);
    });
});

class FixtureGitHub extends GitHub {
    writes: { method: string; body: unknown }[] = [];
    changed = false;
    foreign = false;
    constructor() {
        super("szymboot/example", 1, "szymboot[bot]");
    }
    override async api<T>(method: string, path: string, body?: unknown): Promise<T> {
        if (method === "GET" && path.endsWith("/pulls/1"))
            return { head: { sha: this.changed ? "b".repeat(40) : sha }, state: "open" } as T;
        if (method === "POST" && path.endsWith("/reviews")) {
            this.writes.push({ method, body });
            this.changed = true;
            return { id: 7, html_url: "url" } as T;
        }
        if (method === "PUT") {
            this.writes.push({ method, body });
            return {} as T;
        }
        if (method === "GET" && path.includes("/issues/comments/"))
            return {
                body: item.body,
                user: { login: this.foreign ? "someone" : this.expectedLogin, type: "Bot" },
            } as T;
        if (method === "PATCH") {
            this.writes.push({ method, body });
            return {} as T;
        }
        throw new Error(`Unexpected request ${method} ${path}`);
    }
    override async graphql<T>(_query: string, _variables: Record<string, unknown>): Promise<T> {
        return {
            node: {
                isResolved: false,
                comments: {
                    nodes: [
                        {
                            body: item.body,
                            author: {
                                login: this.foreign
                                    ? "someone"
                                    : this.expectedLogin.replace(/\[bot\]$/, ""),
                                __typename: "Bot",
                            },
                        },
                    ],
                },
            },
        } as T;
    }
}
test("adapter refuses foreign threads and issue comments", async () => {
    const api = new FixtureGitHub();
    api.foreign = true;
    await expect(api.resolve(sha, item, "fixed")).rejects.toThrow("ownership");
    await expect(
        api.resolve(sha, { ...item, target: { kind: "comment", id: 1 } }, "fixed"),
    ).rejects.toThrow("ownership");
    expect(api.writes).toEqual([]);
});
test("adapter dismisses its review if head races publication", async () => {
    const api = new FixtureGitHub();
    await expect(api.review(sha, "APPROVE", "clean", [])).rejects.toThrow("Stale");
    expect(api.writes.map((w) => w.method)).toEqual(["POST", "PUT"]);
    expect((api.writes[0]!.body as { commit_id: string }).commit_id).toBe(sha);
});
test("adapter updates a fixed off-diff comment", async () => {
    const api = new FixtureGitHub();
    await api.resolve(sha, { ...item, target: { kind: "comment", id: 1 } }, "verified source fix");
    expect(api.writes).toHaveLength(1);
    expect((api.writes[0]!.body as { body: string }).body).toContain("**Resolved ·");
});

test("collection dismisses only this App's approvals on older SHAs", async () => {
    class ApprovalGitHub extends GitHub {
        dismissed: string[] = [];
        constructor() {
            super("szymboot/example", 1, "szymboot[bot]");
        }
        override async guard(_sha: string) {}
        override async pages<T>(_path: string): Promise<T[]> {
            return [
                {
                    id: 1,
                    state: "APPROVED",
                    commit_id: "old",
                    user: { login: "szymboot[bot]", type: "Bot" },
                },
                {
                    id: 2,
                    state: "APPROVED",
                    commit_id: "old",
                    user: { login: "human", type: "User" },
                },
                {
                    id: 3,
                    state: "APPROVED",
                    commit_id: sha,
                    user: { login: "szymboot[bot]", type: "Bot" },
                },
                {
                    id: 4,
                    state: "CHANGES_REQUESTED",
                    commit_id: "old",
                    user: { login: "szymboot[bot]", type: "Bot" },
                },
            ] as T[];
        }
        override async api<T>(_method: string, path: string): Promise<T> {
            this.dismissed.push(path);
            return {} as T;
        }
    }
    const api = new ApprovalGitHub();
    await api.invalidatePreviousApprovals(sha);
    expect(api.dismissed).toEqual(["/repos/szymboot/example/pulls/1/reviews/1/dismissals"]);
});

test("snapshot recognizes GraphQL Bot login without REST suffix and ignores foreign markers", async () => {
    class SnapshotGitHub extends GitHub {
        constructor() {
            super("szymboot/example", 1, "szymboot[bot]");
        }
        override async api<T>(_method: string, path: string): Promise<T> {
            if (path.startsWith("/installation/repositories")) return {} as T;
            if (path.endsWith("/pulls/1")) return { state: "open", head: { sha } } as T;
            if (path.includes("/comments?"))
                return [
                    {
                        id: 1,
                        body: findingBody({ ...bug, id: "off-diff" }, sha),
                        user: { login: "szymboot[bot]", type: "Bot" },
                    },
                    { id: 2, body: item.body, user: { login: "human", type: "User" } },
                ] as T;
            throw new Error("Unexpected API call");
        }
        override async graphql<T>(query: string, _variables: Record<string, unknown>): Promise<T> {
            if (query.includes("viewer")) return { viewer: { login: "szymboot[bot]" } } as T;
            const thread = (id: string, login: string, typename: string, isResolved = false) => ({
                id,
                isResolved,
                comments: {
                    nodes: [{ body: item.body, author: { login, __typename: typename } }],
                    pageInfo: { hasNextPage: false, endCursor: null },
                },
            });
            return {
                repository: {
                    pullRequest: {
                        reviewThreads: {
                            nodes: [
                                thread("own", "szymboot", "Bot"),
                                thread("foreign", "someone", "Bot"),
                                thread("forged", "szymboot", "User"),
                                thread("closed", "szymboot", "Bot", true),
                            ],
                            pageInfo: { hasNextPage: false, endCursor: null },
                        },
                    },
                },
            } as T;
        }
    }
    const result = await new SnapshotGitHub().snapshot();
    expect(result.login).toBe("szymboot[bot]");
    expect(result.tracked.map((entry) => entry.target)).toEqual([
        { kind: "thread", id: "own" },
        { kind: "comment", id: 1 },
    ]);
});
