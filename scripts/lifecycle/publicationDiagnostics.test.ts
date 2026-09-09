import { expect, test } from "bun:test";
import { GitHub } from "./github.ts";
import {
    PublicationError,
    publicationDiagnostic,
    publicationStep,
} from "./publicationDiagnostics.ts";
import { findingBody } from "./marker.ts";
import type { Tracked } from "./contract.ts";

const github = () => new GitHub("szymboot/example", 1, "szymboot[bot]");
async function withResponse(response: () => Promise<Response>, run: () => Promise<unknown>) {
    const previous = globalThis.fetch;
    globalThis.fetch = response as unknown as typeof fetch;
    try {
        await run();
    } finally {
        globalThis.fetch = previous;
    }
}
async function label(run: () => Promise<unknown>) {
    try {
        await run();
        throw new Error("Expected failure");
    } catch (error) {
        const result = publicationDiagnostic(error);
        expect(result).not.toBe("");
        return result;
    }
}

test("REST failures retain status and publication operation without response text", async () => {
    await withResponse(
        async () => new Response("secret-token", { status: 403 }),
        async () => {
            expect(
                await label(() =>
                    publicationStep("resolve-finding", () => github().api("GET", "/synthetic")),
                ),
            ).toBe("publication=http; operation=resolve-finding; http_status=403");
        },
    );
});

test("GraphQL error types are classified without messages, paths or untrusted type values", async () => {
    await withResponse(
        async () =>
            Response.json({
                data: null,
                errors: [
                    { type: "FORBIDDEN", message: "secret-token" },
                    { type: "private-token", path: ["private-data"] },
                ],
            }),
        async () => {
            expect(
                await label(() =>
                    publicationStep("resolve-finding", () =>
                        github().graphql("query { viewer { login } }", {}),
                    ),
                ),
            ).toBe(
                "publication=graphql; operation=resolve-finding; graphql_types=FORBIDDEN,UNKNOWN",
            );
        },
    );
});

test("network and malformed response failures are distinct", async () => {
    await withResponse(
        async () => {
            throw new Error("token=secret");
        },
        async () => {
            expect(await label(() => github().api("GET", "/synthetic"))).toBe(
                "publication=network; operation=github",
            );
        },
    );
    await withResponse(
        async () => new Response("secret-token", { status: 200 }),
        async () => {
            expect(await label(() => github().api("GET", "/synthetic"))).toBe(
                "publication=response-json; operation=github",
            );
        },
    );
});

test("snapshot and unexpected failures retain only safe context", async () => {
    expect(
        await label(() =>
            publicationStep("snapshot-refresh", async () => {
                throw new PublicationError("pagination-limit");
            }),
        ),
    ).toBe("publication=pagination-limit; operation=snapshot-refresh");
    expect(
        await label(() =>
            publicationStep("submit-review", async () => {
                throw new TypeError("secret-token");
            }),
        ),
    ).toBe("publication=unexpected; operation=submit-review");
});

const finding = {
    id: "synthetic-fix",
    file: "fixture.ts",
    line: 1,
    severity: "bug" as const,
    blocking: true,
    title: "Bug",
    body: "Bug",
};
const tracked: Tracked = {
    finding,
    body: findingBody(finding, "a".repeat(40)),
    target: { kind: "thread", id: "thread" },
};
class ResolutionGitHub extends GitHub {
    confirmed = true;
    mutationCount = 0;
    constructor() {
        super("szymboot/example", 1, "szymboot[bot]");
    }
    override async guard(_sha: string) {}
    override async graphql<T>(query: string, _variables: Record<string, unknown>): Promise<T> {
        if (query.startsWith("mutation")) {
            this.mutationCount++;
            return {
                resolveReviewThread: { thread: { id: "thread", isResolved: this.confirmed } },
            } as T;
        }
        return {
            node: {
                isResolved: false,
                comments: {
                    nodes: [
                        { body: tracked.body, author: { login: "szymboot", __typename: "Bot" } },
                    ],
                },
            },
        } as T;
    }
}
test("owned thread resolution requires affirmative mutation confirmation", async () => {
    const api = new ResolutionGitHub();
    await api.resolve("a".repeat(40), tracked, "verified");
    expect(api.mutationCount).toBe(1);
    api.confirmed = false;
    expect(
        await label(() =>
            publicationStep("resolve-finding", () =>
                api.resolve("a".repeat(40), tracked, "verified"),
            ),
        ),
    ).toBe("publication=resolution-unconfirmed; operation=resolve-finding");
});
