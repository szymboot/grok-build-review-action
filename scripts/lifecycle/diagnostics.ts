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
