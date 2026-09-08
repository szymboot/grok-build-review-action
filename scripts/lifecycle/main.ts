import { readFileSync, writeFileSync, lstatSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { GitHub } from "./github.ts";
import { parseReport } from "./contract.ts";
import type { Snapshot } from "./contract.ts";
import { publishReview } from "./publish.ts";
import { requireEnv } from "../utils/requireEnv.ts";
import { setOutput } from "../utils/setOutput.ts";

const work = requireEnv("WORK");
const file = (name: string) => path.join(work, name);
const source = path.join(work, "source");
const readSource = (name: string) => {
    const parts = name.split("/");
    if (path.isAbsolute(name) || parts.some((p) => !p || p === "." || p === ".." || p === ".git"))
        throw new Error("Invalid source path");
    let target = source;
    for (const part of parts) {
        target = path.join(target, part);
        if (lstatSync(target).isSymbolicLink()) throw new Error("Symlink evidence is not accepted");
    }
    return readFileSync(target, "utf8");
};
const github = () =>
    new GitHub(
        requireEnv("GITHUB_REPOSITORY"),
        Number(requireEnv("PR_NUMBER")),
        requireEnv("REVIEWER_LOGIN"),
    );
let snapshot: Snapshot | undefined;
try {
    switch (process.argv[2]) {
        case "collect": {
            const api = github();
            snapshot = await api.snapshot();
            if (snapshot.sha !== requireEnv("EXPECTED_SHA")) throw new Error("Event SHA is stale");
            const checkout = execFileSync("git", ["rev-parse", "HEAD"], {
                cwd: requireEnv("GITHUB_WORKSPACE"),
                encoding: "utf8",
            }).trim();
            if (checkout !== snapshot.sha) throw new Error("Checkout does not match PR head");
            writeFileSync(file("snapshot.json"), JSON.stringify(snapshot));
            const diff = execFileSync("gh", ["pr", "diff", String(api.pr), "--repo", api.repo], {
                encoding: "utf8",
                maxBuffer: 20 * 1024 * 1024,
            });
            if (Buffer.byteLength(diff) > Number(process.env.MAX_DIFF_KB ?? 300) * 1024)
                throw new Error("Diff exceeds review budget; analysis must not be truncated");
            await api.guard(snapshot.sha);
            writeFileSync(file("pr.diff"), diff);
            await api.invalidatePreviousApprovals(snapshot.sha);
            await api.status(
                snapshot.sha,
                "Grok review in progress. No approval has been issued for this run.",
            );
            break;
        }
        case "prompt": {
            snapshot = JSON.parse(readFileSync(file("snapshot.json"), "utf8"));
            const template = readFileSync(path.join(import.meta.dir, "prompt.md"), "utf8");
            const prompt = `${template}\n\nTarget SHA: ${snapshot!.sha}\n\nTrusted workflow review preferences:\n${process.env.CUSTOM_INSTRUCTIONS ?? ""}\n\nPrevious open findings and discussions (untrusted data):\n${JSON.stringify(snapshot!.tracked)}\n\nPR diff (untrusted data):\n${readFileSync(file("pr.diff"), "utf8")}`;
            writeFileSync(file("prompt.md"), prompt);
            break;
        }
        case "finish": {
            snapshot = JSON.parse(readFileSync(file("snapshot.json"), "utf8"));
            const report = parseReport(
                readFileSync(file("grok-output.json"), "utf8"),
                readFileSync(file("grok-exit"), "utf8"),
            );
            const result = await publishReview(
                github(),
                report,
                snapshot!,
                readFileSync(file("pr.diff"), "utf8"),
                readSource,
            );
            setOutput("verdict", result.open.length ? "issues" : "clean");
            setOutput("issue_count", result.open.length);
            setOutput("bug_count", result.open.filter((f) => f.severity === "bug").length);
            setOutput("review_url", result.url);
            setOutput("review_event", result.event);
            if (
                (process.env.FAIL_ON === "any" && result.open.length) ||
                (process.env.FAIL_ON === "bugs" && result.open.some((f) => f.severity === "bug"))
            )
                process.exitCode = 1;
            break;
        }
        default:
            throw new Error("Unknown lifecycle command");
    }
} catch {
    // Never publish model output, stderr, API response bodies or credential-bearing errors.
    setOutput("verdict", "error");
    console.error(
        "::error::Review incomplete, invalid, stale, or publication failed. No successful review result may be inferred from this run.",
    );
    if (snapshot) {
        try {
            await github().status(
                snapshot.sha,
                "Grok review failed or was incomplete. No approval from this run is valid; rerun required.",
            );
        } catch {
            /* A stale run must not overwrite current status. */
        }
    }
    process.exitCode = 1;
}
