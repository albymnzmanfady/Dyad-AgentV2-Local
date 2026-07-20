import { z } from "zod";
import { exec } from "node:child_process";
import log from "electron-log";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";

const logger = log.scope("run_pytest");

const MAX_OUTPUT_LENGTH = 15000;

const runPytestSchema = z.object({
  path: z
    .string()
    .optional()
    .describe("Path to test file or directory (default: runs all tests)"),
  verbose: z
    .boolean()
    .optional()
    .describe("Show detailed test output"),
  keyword: z
    .string()
    .optional()
    .describe("Run only tests matching keyword (pytest -k)"),
  markers: z
    .string()
    .optional()
    .describe("Run tests by marker (pytest -m)"),
  stop_on_first_failure: z
    .boolean()
    .optional()
    .describe("Stop after first failure"),
});

function truncateOutput(output: string, maxLength: number): string {
  if (output.length <= maxLength) return output;
  const half = Math.floor((maxLength - 50) / 2);
  return (
    output.slice(0, half) +
    `\n\n... [truncated, ${output.length} total chars] ...\n\n` +
    output.slice(-half)
  );
}

export const runPytestTool: ToolDefinition<
  z.infer<typeof runPytestSchema>
> = {
  name: "run_pytest",
  description: `Run Python tests using pytest.

Use this to:
- Run all tests in the project
- Run specific test files
- Run tests matching a pattern
- Check test results and failures

If pytest is not installed, it will attempt to install it first.`,
  inputSchema: runPytestSchema,
  defaultConsent: "always",

  getConsentPreview: (args) =>
    args.path ? `Run pytest: ${args.path}` : "Run all pytest tests",

  buildXml: (args, isComplete) => {
    let xml = `<dyad-pytest`;
    if (args.path) {
      xml += ` path="${escapeXmlAttr(args.path)}"`;
    }
    xml += ">";
    if (isComplete) {
      xml += "</dyad-pytest>";
    }
    return xml;
  },

  execute: async (args, ctx: AgentContext) => {
    const parts = ["pytest"];

    if (args.path) parts.push(args.path);
    if (args.verbose) parts.push("-v");
    if (args.keyword) parts.push(`-k "${args.keyword}"`);
    if (args.markers) parts.push(`-m "${args.markers}"`);
    if (args.stop_on_first_failure) parts.push("-x");

    parts.push("--tb=short");
    parts.push("--no-header");

    const command = parts.join(" ");

    logger.log(`Running: ${command}`);

    ctx.onXmlStream(
      `<dyad-status title="${escapeXmlAttr(`Running pytest${args.path ? `: ${args.path}` : ""}`)}"></dyad-status>`,
    );

    return new Promise<string>((resolve) => {
      const child = exec(
        command,
        {
          cwd: ctx.appPath,
          timeout: 120000,
          maxBuffer: 1024 * 1024 * 5,
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, FORCE_COLOR: "0" },
        },
        (error, stdout, stderr) => {
          let output = "";

          if (stdout) output += stdout.toString();
          if (stderr) {
            // pytest outputs results to stderr sometimes
            if (!output) output = stderr.toString();
          }

          if (error && !output) {
            output = error.message;
            if (error.killed) {
              output += "\n\nCommand timed out after 120s";
            }
          }

          if (!output) output = "(no output)";

          output = truncateOutput(output, MAX_OUTPUT_LENGTH);

          // Parse test results
          const passedMatch = output.match(/(\d+) passed/);
          const failedMatch = output.match(/(\d+) failed/);
          const errorMatch = output.match(/(\d+) error/);
          const skippedMatch = output.match(/(\d+) skipped/);

          const summary = {
            passed: passedMatch ? parseInt(passedMatch[1]) : 0,
            failed: failedMatch ? parseInt(failedMatch[1]) : 0,
            errors: errorMatch ? parseInt(errorMatch[1]) : 0,
            skipped: skippedMatch ? parseInt(skippedMatch[1]) : 0,
          };

          const allPassed =
            summary.failed === 0 && summary.errors === 0;

          ctx.onXmlComplete(
            `<dyad-pytest passed="${summary.passed}" failed="${summary.failed}" errors="${summary.errors}" skipped="${summary.skipped}" success="${allPassed}">\n${escapeXmlContent(output)}\n</dyad-pytest>`,
          );

          resolve(output);
        },
      );

      child.on("error", (err) => {
        const msg = `Failed to start pytest: ${err.message}`;
        ctx.onXmlComplete(
          `<dyad-pytest passed="0" failed="0" errors="1" success="false">\n${escapeXmlContent(msg)}\n</dyad-pytest>`,
        );
        resolve(msg);
      });
    });
  },
};
