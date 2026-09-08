import { expect, test } from "bun:test";
import { cliDiagnostic } from "./diagnostics.ts";

test("permission failure from cap-dropped root is identified without exposing stderr", () => {
    expect(
        cliDiagnostic(
            "1",
            "",
            "Error: Failed to load config: Permission denied (os error 13)\nsecret=do-not-publish",
        ),
    ).toBe("cli_exit=1; cli_category=filesystem-permission");
});

test("authentication, limit and CLI incompatibility have stable safe labels", () => {
    expect(cliDiagnostic("1", '{"type":"error","message":"Not signed in. token=secret"}', "")).toBe(
        "cli_exit=1; cli_category=authentication",
    );
    expect(cliDiagnostic("1", "quota exceeded: secret", "")).toBe("cli_exit=1; cli_category=limit");
    expect(cliDiagnostic("2", "", "error: unexpected argument '--example' found")).toBe(
        "cli_exit=2; cli_category=cli-arguments",
    );
});

test("untrusted errors and exit text cannot inject workflow commands or secrets", () => {
    expect(cliDiagnostic("::error::secret", "secret payload", "secret payload")).toBe(
        "cli_exit=missing; cli_category=unknown",
    );
    expect(cliDiagnostic("0\n", "secret payload", "")).toBe(
        "cli_exit=0; cli_category=process-succeeded",
    );
});
