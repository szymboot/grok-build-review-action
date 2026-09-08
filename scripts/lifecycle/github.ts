import { ghApi } from "../github/ghApi.ts";
import { findingBody, readFinding, resolvedBody, statusMarker } from "./marker.ts";
import type { Finding, Snapshot, Tracked } from "./contract.ts";

export class GitHub {
    constructor(
        readonly repo: string,
        readonly pr: number,
        readonly expectedLogin: string,
    ) {}
    async api<T>(
        method: "GET" | "POST" | "PATCH" | "PUT",
        path: string,
        body?: unknown,
    ): Promise<T> {
        const result = await ghApi<T>(method, path, body);
        if (!result.ok) throw new Error(`GitHub ${method} failed (${result.status})`);
        return result.data;
    }
    async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
        const result = await this.api<{ data: T; errors?: unknown[] }>("POST", "/graphql", {
            query,
            variables,
        });
        if (result.errors?.length || !result.data) throw new Error("Incomplete GraphQL response");
        return result.data;
    }
    async pages<T>(path: string): Promise<T[]> {
        const items: T[] = [];
        for (let page = 1; page <= 100; page++) {
            const next = await this.api<T[]>("GET", `${path}?per_page=100&page=${page}`);
            items.push(...next);
            if (next.length < 100) return items;
        }
        throw new Error("Pagination limit reached; refusing incomplete history");
    }
    async head() {
        return this.api<{ head: { sha: string }; state: string }>(
            "GET",
            `/repos/${this.repo}/pulls/${this.pr}`,
        );
    }
    async guard(sha: string) {
        const current = await this.head();
        if (current.head.sha !== sha || current.state !== "open")
            throw new Error("Stale SHA or closed pull request");
    }
    async identity() {
        // Installation tokens can access this endpoint; user tokens must not substitute for the App.
        await this.api("GET", "/installation/repositories?per_page=1");
        const result = await this.graphql<{ viewer: { login: string } }>(
            "query { viewer { login } }",
            {},
        );
        if (
            !this.expectedLogin.endsWith("[bot]") ||
            result.viewer.login.replace(/\[bot\]$/, "") !==
                this.expectedLogin.replace(/\[bot\]$/, "")
        )
            throw new Error("Unexpected GitHub App identity");
        return this.expectedLogin;
    }
    async invalidatePreviousApprovals(sha: string) {
        const reviews = await this.pages<{
            id: number;
            state: string;
            commit_id: string;
            user: { login: string; type: string };
        }>(`/repos/${this.repo}/pulls/${this.pr}/reviews`);
        for (const review of reviews) {
            if (
                review.state !== "APPROVED" ||
                review.commit_id === sha ||
                review.user.login !== this.expectedLogin ||
                review.user.type !== "Bot"
            )
                continue;
            await this.guard(sha);
            await this.api(
                "PUT",
                `/repos/${this.repo}/pulls/${this.pr}/reviews/${review.id}/dismissals`,
                { message: "A new PR head requires a new complete analysis." },
            );
        }
    }
    async comments() {
        return this.pages<{ id: number; body: string; user: { login: string; type: string } }>(
            `/repos/${this.repo}/issues/${this.pr}/comments`,
        );
    }
    async snapshot(): Promise<Snapshot> {
        const login = await this.identity();
        const head = await this.head();
        const tracked: Tracked[] = [];
        const [owner, name] = this.repo.split("/");
        let cursor: string | null = null;
        type Comment = { body: string; author: { login: string; __typename: string } | null };
        type Connection = {
            nodes: Comment[];
            pageInfo: { hasNextPage: boolean; endCursor: string };
        };
        type Thread = { id: string; isResolved: boolean; comments: Connection };
        for (let page = 0; ; page++) {
            if (page >= 100) throw new Error("Thread pagination limit reached");
            const result: {
                repository: {
                    pullRequest: {
                        reviewThreads: {
                            nodes: Thread[];
                            pageInfo: { hasNextPage: boolean; endCursor: string };
                        };
                    };
                };
            } = await this.graphql(
                `query($owner:String!,$name:String!,$pr:Int!,$cursor:String) {
                repository(owner:$owner,name:$name) { pullRequest(number:$pr) { reviewThreads(first:100,after:$cursor) {
                    nodes { id isResolved comments(first:100) { nodes { body author { login __typename } } pageInfo { hasNextPage endCursor } } }
                    pageInfo { hasNextPage endCursor }
                } } }
            }`,
                { owner, name, pr: this.pr, cursor },
            );
            const connection = result.repository.pullRequest.reviewThreads;
            for (const thread of connection.nodes) {
                const root = thread.comments.nodes[0];
                if (
                    thread.isResolved ||
                    root?.author?.login.replace(/\[bot\]$/, "") !== login.replace(/\[bot\]$/, "") ||
                    root.author.__typename !== "Bot"
                )
                    continue;
                const finding = readFinding(root.body);
                if (!finding)
                    throw new Error(
                        "Untracked App thread requires manual migration before approval",
                    );
                const history = [...thread.comments.nodes];
                let next = thread.comments.pageInfo;
                for (let i = 0; next.hasNextPage; i++) {
                    if (i >= 100) throw new Error("Comment pagination limit reached");
                    const result: { node: { comments: Connection } } = await this.graphql(
                        `query($id:ID!,$cursor:String!) { node(id:$id) { ... on PullRequestReviewThread { comments(first:100,after:$cursor) { nodes { body author { login __typename } } pageInfo { hasNextPage endCursor } } } } }`,
                        { id: thread.id, cursor: next.endCursor },
                    );
                    history.push(...result.node.comments.nodes);
                    next = result.node.comments.pageInfo;
                }
                tracked.push({
                    finding,
                    body: history
                        .map((c) => `${c.author?.login ?? "deleted"}:\n${c.body}`)
                        .join("\n\n"),
                    target: { kind: "thread", id: thread.id },
                });
            }
            if (!connection.pageInfo.hasNextPage) break;
            cursor = connection.pageInfo.endCursor;
        }
        for (const comment of await this.comments()) {
            if (comment.user.login !== login || comment.user.type !== "Bot") continue;
            const finding = readFinding(comment.body);
            if (finding && !comment.body.includes("**Resolved ·"))
                tracked.push({
                    finding,
                    body: comment.body,
                    target: { kind: "comment", id: comment.id },
                });
        }
        await this.guard(head.head.sha);
        return { sha: head.head.sha, login, tracked };
    }
    async status(sha: string, message: string) {
        await this.guard(sha);
        const matches = (await this.comments()).filter(
            (c) =>
                c.user.login === this.expectedLogin &&
                c.user.type === "Bot" &&
                c.body.startsWith(statusMarker),
        );
        const body = `${statusMarker}\n${message}\n\nReviewed SHA: \`${sha}\``;
        await this.guard(sha);
        if (matches[0])
            await this.api("PATCH", `/repos/${this.repo}/issues/comments/${matches[0].id}`, {
                body,
            });
        else await this.api("POST", `/repos/${this.repo}/issues/${this.pr}/comments`, { body });
    }
    async resolve(sha: string, tracked: Tracked, explanation: string) {
        await this.guard(sha);
        // Re-fetch ownership and state immediately before mutation, never trust model-supplied IDs.
        if (tracked.target.kind === "thread") {
            const data = await this.graphql<{
                node: {
                    isResolved: boolean;
                    comments: {
                        nodes: { body: string; author: { login: string; __typename: string } }[];
                    };
                };
            }>(
                `query($id:ID!) { node(id:$id) { ... on PullRequestReviewThread { isResolved comments(first:1) { nodes { body author { login __typename } } } } } }`,
                { id: tracked.target.id },
            );
            const root = data.node.comments.nodes[0];
            if (
                root?.author.login.replace(/\[bot\]$/, "") !==
                    this.expectedLogin.replace(/\[bot\]$/, "") ||
                root.author.__typename !== "Bot" ||
                readFinding(root.body)?.id !== tracked.finding.id
            )
                throw new Error("Thread ownership changed");
            if (data.node.isResolved) return;
            await this.guard(sha);
            await this.graphql(
                `mutation($id:ID!) { resolveReviewThread(input:{threadId:$id}) { thread { id isResolved } } }`,
                { id: tracked.target.id },
            );
        } else {
            const comment = await this.api<{ body: string; user: { login: string; type: string } }>(
                "GET",
                `/repos/${this.repo}/issues/comments/${tracked.target.id}`,
            );
            if (
                comment.user.login !== this.expectedLogin ||
                comment.user.type !== "Bot" ||
                readFinding(comment.body)?.id !== tracked.finding.id
            )
                throw new Error("Comment ownership changed");
            await this.guard(sha);
            await this.api("PATCH", `/repos/${this.repo}/issues/comments/${tracked.target.id}`, {
                body: resolvedBody(comment.body, sha, explanation),
            });
        }
    }
    async issue(sha: string, finding: Finding) {
        await this.guard(sha);
        await this.api("POST", `/repos/${this.repo}/issues/${this.pr}/comments`, {
            body: findingBody(finding, sha),
        });
    }
    async review(
        sha: string,
        event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES",
        body: string,
        comments: { path: string; line: number; side: "RIGHT"; body: string }[],
    ) {
        await this.guard(sha);
        const result = await this.api<{ id: number; html_url: string }>(
            "POST",
            `/repos/${this.repo}/pulls/${this.pr}/reviews`,
            { commit_id: sha, event, body: `${body}\n\nReviewed SHA: \`${sha}\``, comments },
        );
        try {
            await this.guard(sha);
        } catch (error) {
            if (event === "APPROVE" || event === "REQUEST_CHANGES")
                await this.api(
                    "PUT",
                    `/repos/${this.repo}/pulls/${this.pr}/reviews/${result.id}/dismissals`,
                    {
                        message:
                            "The PR changed during publication. This review applies only to the previous SHA.",
                    },
                );
            throw error;
        }
        return result.html_url;
    }
}
