import { z } from "zod";
import { exec } from "node:child_process";
import log from "electron-log";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";

const logger = log.scope("run_lint_python");

const MAX_OUTPUT_LENGTH = 15000;

const runLintPythonSchema = z.object({
  path: z
    .string()
    .optional()
    .describe("Path to file or directory to lint (default: current directory)"),
  linter: z
    .enum(["pylint", "flake8", "ruff", "mypy", "auto"])
    .optional()
    .describe("Linter to use (default: auto-detects available)"),
  fix: z
    .boolean()
    .optional()
    .describe("Auto-fix issues where possible (ruff, flake8)"),
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

async function findLinter(
  preferred: string,
): Promise<{ cmd: string; name: string } | null> {
  const linters = [
    { name: "ruff", cmd: "ruff check" },
    { name: "flake8", cmd: "flake8" },
    { name: "pylint", cmd: "pylint" },
    { name: "mypy", cmd: "mypy" },
  ];

  // If specific linter requested, try only that one
  if (preferred !== "auto") {
    const found = linters.find((l) => l.name === preferred);
    if (found) {
      try {
        const result = await new Promise<boolean>((resolve) => {
          exec(`${found.cmd} --version`, { windowsHide: true }, (error) => {
            resolve(!error);
          });
        });
        if (result) return found;
      } catch {
        return null;
      }
    }
    return null;
  }

  // Auto-detect: try in order of preference
  for (const linter of linters) {
    try {
      const result = await new Promise<boolean>((resolve) => {
        exec(`${linter.cmd} --version`, { windowsHide: true }, (error) => {
          resolve(!error);
        });
      });
      if (result) return linter;
    } catch {
      continue;
    }
  }

  return null;
}

export const runLintPythonTool: ToolDefinition<
  z.infer<typeof runLintPythonSchema>
> = {
  name: "run_lint_python",
  description: `Run Python linter to check code quality and find issues.

Available linters (auto-detected):
- ruff: Fast Python linter (preferred)
- flake8: PEP 8 style checker
- pylint: Comprehensive linter
- mypy: Static type checker

Use this to:
- Check code for errors before running
- Verify code quality
- Auto-fix issues (ruff/flake8 only)`,
  inputSchema: runLintPythonSchema,
  defaultConsent: "always",

  getConsentPreview: (args) =>
    args.path ? `Lint: ${args.path}` : "Lint Python project",

  buildXml: (args, isComplete) => {
    let xml = `<dyad-lint-python`;
    if (args.path) {
      xml += ` path="${escapeXmlAttr(args.path)}"`;
    }
    xml += ">";
    if (isComplete) {
      xml += "</dyad-lint-python>";
    }
    return xml;
  },

  execute: async (args, ctx: AgentContext) => {
    const linterName = args.linter ?? "auto";
    const linter = await findLinter(linterName);

    if (!linter) {
      const msg = `No Python linter found. Install one:
  pip install ruff        (fastest)
  pip install flake8
  pip install pylint
  pip install mypy`;
      ctx.onXmlComplete(
        `<dyad-lint-python linter="none" success="false">\n${escapeXmlContent(msg)}\n</dyad-lint-python>`,
      );
      return msg;
    }

    const target = args.path ?? ".";
    let command: string;

    if (linter.name === "ruff" && args.fix) {
      command = `ruff check --fix "${target}"`;
    } else if (linter.name === "flake8" && args.fix) {
      command = `flake8 --auto-fix "${target}"`;
    } else if (linter.name === "mypy") {
      command = `mypy "${target}" --ignore-missing-imports`;
    } else {
      command = `${linter.cmd} "${target}"`;
    }

    logger.log(`Running: ${command}`);

    ctx.onXmlStream(
      `<dyad-status title="${escapeXmlAttr(`Linting with ${linter.name}: ${target}`)}"></dyad-status>`,
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
            if (!output) output = stderr.toString();
          }

          if (error && !output) {
            output = error.message;
          }

          if (!output) output = "(no issues found)";

          output = truncateOutput(output, MAX_OUTPUT_LENGTH);

          // Count issues
          const issueCount = (output.match(/^\s*\w+\.py:\d+/gm) ?? [])
            .length;
          const hasIssues =
            issueCount > 0 || output.includes("E") || output.includes("W");

          ctx.onXmlComplete(
            `<dyad-lint-python linter="${linter.name}" issues="${issueCount}" success="${!hasIssues}">\n${escapeXmlContent(output)}\n</dyad-lint-python>`,
          );

          resolve(output);
        },
      );

      child.on("error", (err) => {
        const msg = `Failed to run ${linter.name}: ${err.message}`;
        ctx.onXmlComplete(
          `<dyad-lint-python linter="${linter.name}" issues="0" success="false">\n${escapeXmlContent(msg)}\n</dyad-lint-python>`,
        );
        resolve(msg);
      });
    });
  },
};
