/**
 * SDK-PARITY-001: CLI trampoline — the logic lives in src/sdk/cli.ts so the
 * root `tsc --noEmit` gate type-checks it like the rest of src/.
 */
import { runSdkCli } from "../src/sdk/cli.js";

process.exitCode = runSdkCli(process.argv.slice(2));
