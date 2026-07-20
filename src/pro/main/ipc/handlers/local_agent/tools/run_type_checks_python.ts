import { z } from "zod";
import { exec } from "node:child_process";
import log from "electron-log";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";

const logger = log.scope("run_type_checks_python");

const MAX_OUTPUT_LENGTH = 15000;

const runTypeChecksPythonSchema = z.object({
  path: z
    .string()
    .optional()
    .describe(
      "Path to file or directory to type-check (default: current directory)",
    ),
  strict: z
    .boolean()
    .optional()
    .describe("Enable strict mode for more thorough checking"),
  ignore_missing_imports: z
    .boolean()
    .optional()
    .describe("Ignore missing type stubs (default: true)"),
  tool: z
    .enum(["mypy", "pyright", "auto"])
    .optional()
    .describe("Type checker to use (default: auto-detects available)"),
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

async function findTypeChecker(
  preferred: string,
): Promise<{ cmd: string; name: string } | null> {
  const checkers = [
    { name: "pyright", cmd: "pyright" },
    { name: "mypy", cmd: "mypy" },
  ];

  if (preferred !== "auto") {
    const found = checkers.find((c) => c.name === preferred);
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

  for (const checker of checkers) {
    try {
      const result = await new Promise<boolean>((resolve) => {
        exec(`${checker.cmd} --version`, { windowsHide: true }, (error) => {
          resolve(!error);
        });
      });
      if (result) return checker;
    } catch {
      continue;
    }
  }

  return null;
}

export const runTypeChecksPythonTool: ToolDefinition<
  z.infer<typeof runTypeChecksPythonSchema>
> = {
  name: "run_type_checks_python",
  description: `Run Python type checking using mypy or pyright.

Use this to:
- Verify type annotations are correct
- Find type errors before runtime
- Ensure code quality

Available tools:
- pyright: Fast, modern type checker (preferred)
- mypy: Comprehensive type checker

If no tool is installed, will suggest installation.`,
  inputSchema: runTypeChecksPythonSchema,
  defaultConsent: "always",

  getConsentPreview: (args) =>
    args.path
      ? `Type-check Python: ${args.path}`
      : "Type-check Python project",

  buildXml: (args, isComplete) => {
    let xml = `<dyad-typecheck-python`;
    if (args.path) {
      xml += ` path="${escapeXmlAttr(args.path)}"`;
    }
    xml += ">";
    if (isComplete) {
      xml += "</dyad-typecheck-python>";
    }
    return xml;
  },

  execute: async (args, ctx: AgentContext) => {
    const toolName = args.tool ?? "auto";
    const checker = await findTypeChecker(toolName);

    if (!checker) {
      const msg = `No Python type checker found. Install one:
  pip install pyright    (fastest, preferred)
  pip install mypy       (comprehensive)

Then retry the type check.`;
      ctx.onXmlComplete(
        `<dyad-typecheck-python tool="none" errors="0" success="false">\n${escapeXmlContent(msg)}\n</dyad-typecheck-python>`,
      );
      return msg;
    }

    const target = args.path ?? ".";

    let command: string;
    if (checker.name === "pyright") {
      const parts = ["pyright", `"${target}"`];
      if (args.strict) parts.push("--strict");
      command = parts.join(" ");
    } else {
      // mypy
      const parts = ["mypy", `"${target}"`];
      if (args.ignore_missing_imports !== false) {
        parts.push("--ignore-missing-imports");
      }
      if (args.strict) parts.push("--strict");
      command = parts.join(" ");
    }

    logger.log(`Running: ${command}`);

    ctx.onXmlStream(
      `<dyad-status title="${escapeXmlAttr(`Type-checking Python with ${checker.name}: ${target}`)}"></dyad-status>`,
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

          if (!output) output = "(no type errors found)";

          output = truncateOutput(output, MAX_OUTPUT_LENGTH);

          // Count errors
          const errorMatches = output.match(/^.*error:.*$/gm) ?? [];
          const errorCount = errorMatches.length;
          const hasErrors =
            errorCount > 0 ||
            output.includes("error:") ||
            output.includes("Error:");

          // Format error report
          let report = `## Python Type Check Results\n\n`;
          report += `**Tool:** ${checker.name}\n`;
          report += `**Target:** ${target}\n`;
          report += `**Errors:** ${errorCount}\n\n`;

          if (errorCount > 0) {
            report += `### Errors\n\n`;
            for (const err of errorMatches.slice(0, 20)) {
              report += `- ${err.trim()}\n`;
            }
            if (errorMatches.length > 20) {
              report += `\n... and ${errorMatches.length - 20} more errors\n`;
            }
          } else {
            report += `No type errors found! ✅\n`;
          }

          ctx.onXmlComplete(
            `<dyad-typecheck-python tool="${checker.name}" errors="${errorCount}" success="${!hasErrors}">\n${escapeXmlContent(report)}\n</dyad-typecheck-python>`,
          );

          resolve(report);
        },
      );

      child.on("error", (err) => {
        const msg = `Failed to run ${checker.name}: ${err.message}`;
        ctx.onXmlComplete(
          `<dyad-typecheck-python tool="${checker.name}" errors="0" success="false">\n${escapeXmlContent(msg)}\n</dyad-typecheck-python>`,
        );
        resolve(msg);
      });
    });
  },
};
