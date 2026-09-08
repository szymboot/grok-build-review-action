// Return only fixed labels: raw CLI output can contain credentials or PR-controlled text.
export function cliDiagnostic(exitCode: string, stdout: string, stderr: string): string {
    const exit = /^\d{1,3}$/.test(exitCode.trim()) ? exitCode.trim() : "missing";
    const text = `${stderr.slice(0, 65536)}\n${stdout.slice(0, 65536)}`;
    let category = "unknown";
    if (/permission denied|os error 13|EACCES/i.test(text)) category = "filesystem-permission";
    else if (/not signed in|unauthorized|authentication|invalid.grant|expired.token/i.test(text))
        category = "authentication";
    else if (/rate.limit|quota|too many requests|maximum.*turns|max.turns.*reached/i.test(text))
        category = "limit";
    else if (/unexpected argument|unrecognized option|unknown option/i.test(text))
        category = "cli-arguments";
    else if (/cannot connect to.*docker|docker daemon|executable file not found/i.test(text))
        category = "container-startup";
    else if (exit === "0") category = "process-succeeded";
    return `cli_exit=${exit}; cli_category=${category}`;
}

export type ValidationCode =
    | "cli-exit"
    | "envelope-json"
    | "envelope-shape"
    | "envelope-error"
    | "envelope-text"
    | "stop-reason"
    | "review-block-count"
    | "review-json"
    | "review-schema"
    | "analysis-incomplete"
    | "sha-mismatch"
    | "stored-duplicates"
    | "assessment-coverage"
    | "finding-duplicate"
    | "fix-evidence-missing"
    | "fix-evidence-unavailable"
    | "fix-evidence-mismatch";

export class ReviewValidationError extends Error {
    constructor(
        readonly code: ValidationCode,
        readonly detail = "",
    ) {
        super(code);
    }
}

// Paths and codes are reduced to known schema vocabulary; never print Zod messages/input values.
export function schemaDiagnostic(issues: { path: PropertyKey[]; code: string }[]): string {
    const fields = new Set([
        "version",
        "head_sha",
        "complete",
        "summary",
        "findings",
        "assessments",
        "id",
        "file",
        "line",
        "severity",
        "blocking",
        "title",
        "body",
        "status",
        "explanation",
        "evidence",
        "excerpt",
    ]);
    const codes = new Set([
        "invalid_type",
        "invalid_value",
        "invalid_format",
        "too_big",
        "too_small",
        "unrecognized_keys",
        "custom",
        "invalid_union",
    ]);
    return issues
        .slice(0, 5)
        .map((issue) => {
            const path =
                issue.path
                    .slice(0, 8)
                    .map((part) =>
                        typeof part === "number"
                            ? "[]"
                            : typeof part === "string" && fields.has(part)
                              ? part
                              : "unknown",
                    )
                    .join(".") || "root";
            return `${path}:${codes.has(issue.code) ? issue.code : "invalid"}`;
        })
        .join(",");
}

export function validationDiagnostic(error: unknown): string {
    return error instanceof ReviewValidationError
        ? `validation=${error.code}${error.detail ? `; ${error.detail}` : ""}`
        : "";
}
