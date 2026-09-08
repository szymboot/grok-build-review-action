import { FindingSchema } from "./contract.ts";
import type { Finding } from "./contract.ts";

export const statusMarker = "<!-- szymboot-grok-status-v2 -->";
const prefix = "<!-- szymboot-grok-finding-v2:";
export function findingBody(finding: Finding, sha: string) {
    const marker = `${prefix}${Buffer.from(JSON.stringify(finding)).toString("base64")} -->`;
    return `${marker}\n**Open · ${finding.blocking ? "blocking" : "suggestion"}**\n\n### ${finding.title}\n\n${finding.body}\n\nSource: \`${finding.file}${finding.line === null ? "" : `:${finding.line}`}\` · reviewed SHA \`${sha}\``;
}
export function readFinding(body: string): Finding | null {
    if (!body.startsWith(prefix)) return null;
    const encoded = body.slice(prefix.length).split(" -->", 1)[0]!;
    return FindingSchema.parse(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
}
export function resolvedBody(body: string, sha: string, explanation: string) {
    return `${body.replace("**Open ·", "**Resolved ·")}\n\nFix confirmed on \`${sha}\`: ${explanation}`;
}
