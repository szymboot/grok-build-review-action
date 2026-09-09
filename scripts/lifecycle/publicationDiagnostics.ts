export type PublicationOperation =
    | "github"
    | "snapshot-refresh"
    | "history-check"
    | "resolve-finding"
    | "create-off-diff"
    | "publish-status"
    | "submit-review";
export type PublicationCode =
    | "http"
    | "network"
    | "response-json"
    | "graphql"
    | "graphql-response"
    | "history-changed"
    | "pagination-limit"
    | "stale-head"
    | "closed-pr"
    | "app-identity"
    | "untracked-thread"
    | "thread-ownership"
    | "comment-ownership"
    | "thread-unavailable"
    | "resolution-unconfirmed"
    | "unexpected";
const graphTypes = new Set([
    "FORBIDDEN",
    "NOT_FOUND",
    "UNPROCESSABLE",
    "UNAUTHORIZED",
    "RATE_LIMITED",
    "INTERNAL",
    "INTERNAL_SERVER_ERROR",
    "MAX_NODE_LIMIT_EXCEEDED",
]);

export class PublicationError extends Error {
    constructor(
        readonly code: PublicationCode,
        readonly operation: PublicationOperation = "github",
        readonly httpStatus?: number,
        readonly graphqlTypes: string[] = [],
    ) {
        super(code);
    }
}

export function graphqlErrorTypes(errors: unknown[]): string[] {
    return [
        ...new Set(
            errors.slice(0, 5).map((error) => {
                const value =
                    error && typeof error === "object"
                        ? (error as Record<string, unknown>).type
                        : undefined;
                return typeof value === "string" && graphTypes.has(value) ? value : "UNKNOWN";
            }),
        ),
    ];
}

export async function publicationStep<T>(
    operation: PublicationOperation,
    run: () => Promise<T>,
): Promise<T> {
    try {
        return await run();
    } catch (error) {
        if (error instanceof PublicationError)
            throw new PublicationError(error.code, operation, error.httpStatus, error.graphqlTypes);
        // No exception messages: they may contain API responses, credentials or PR text.
        throw new PublicationError("unexpected", operation);
    }
}

export function publicationDiagnostic(error: unknown): string {
    if (!(error instanceof PublicationError)) return "";
    const status =
        error.httpStatus !== undefined &&
        Number.isInteger(error.httpStatus) &&
        error.httpStatus >= 100 &&
        error.httpStatus <= 599
            ? `; http_status=${error.httpStatus}`
            : "";
    const types = error.graphqlTypes.length
        ? `; graphql_types=${error.graphqlTypes.map((type) => (graphTypes.has(type) ? type : "UNKNOWN")).join(",")}`
        : "";
    return `publication=${error.code}; operation=${error.operation}${status}${types}`;
}
