import { importDesktopLogin } from "./desktop-import.ts";
export { importDesktopLogin };

// OpenCode 2 command authentication consumes stdout as a secret key. Do not run
// this file in an agent shell or log its stdout. Only /connect invokes it.
if (import.meta.main) {
  if (process.argv.length !== 3 || process.argv[2] !== "--opencode-auth-command") {
    process.stderr.write("Use the Devin subscription desktop-import connection method in OpenChamber.\n");
    process.exitCode = 1;
  } else {
    const cancellation = new AbortController();
    const cancel = () => cancellation.abort();
    process.once("SIGTERM", cancel); process.once("SIGINT", cancel);
    try { process.stdout.write(await importDesktopLogin({ signal: cancellation.signal })); }
    catch (error) {
      process.stderr.write(`${cancellation.signal.aborted ? "Devin Desktop import canceled." : error instanceof Error ? error.message : "Devin Desktop import failed."}\n`);
      process.exitCode = 1;
    } finally { process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel); }
  }
}
