import { z } from "zod";
import { exec, execSync } from "node:child_process";
import path from "node:path";
import log from "electron-log";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";

const logger = log.scope("run_terminal_command");

const MAX_OUTPUT_LENGTH = 10000;
const DEFAULT_TIMEOUT_MS = 30000;

const runTerminalCommandSchema = z.object({
  command: z
    .string()
    .min(1)
    .max(4096)
    .describe(
      "The shell command to execute (e.g. 'npm install', 'git status', 'npx tsc --noEmit')",
    ),
  timeout: z
    .number()
    .int()
    .min(1000)
    .max(300000)
    .optional()
    .describe("Timeout in milliseconds (default: 30000, max: 300000)"),
  description: z
    .string()
    .max(160)
    .optional()
    .describe("Brief description of what this command does"),
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

export const runTerminalCommandTool: ToolDefinition<
  z.infer<typeof runTerminalCommandSchema>
> = {
  name: "run_terminal_command",
  description: `Execute a shell command in the app's working directory and return its stdout/stderr output.

Use this tool to:
- Run build commands (npm run build, npx tsc --noEmit)
- Run tests (npm test, npx vitest)
- Install packages (npm install, npm add)
- Run git commands (git status, git diff)
- Run linters and formatters (npx oxlint)
- Any other terminal operation

The command runs in the app's root directory with full shell access.
Output is truncated to 10,000 characters. Commands time out after 30 seconds by default.`,
  inputSchema: runTerminalCommandSchema,
  defaultConsent: "always",

  getConsentPreview: (args) =>
    `Run command: ${args.description ?? args.command}`,

  buildXml: (args, isComplete) => {
    if (!args.command) return undefined;
    let xml = `<dyad-terminal command="${escapeXmlAttr(args.command)}"`;
    if (args.description) {
      xml += ` description="${escapeXmlAttr(args.description)}"`;
    }
    xml += ">";
    if (isComplete) {
      xml += "</dyad-terminal>";
    }
    return xml;
  },

  execute: async (args, ctx: AgentContext) => {
    const cwd = ctx.appPath;
    const timeout = Math.min(
      args.timeout ?? DEFAULT_TIMEOUT_MS,
      300000,
    );

    logger.log(`Running command: ${args.command} in ${cwd}`);

    ctx.onXmlStream(
      `<dyad-status title="${escapeXmlAttr(`Running: ${args.command}`)}"></dyad-status>`,
    );

    return new Promise<string>((resolve) => {
      const child = exec(
        args.command,
        {
          cwd,
          timeout,
          maxBuffer: 1024 * 1024 * 5,
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, FORCE_COLOR: "0" },
        },
        (error, stdout, stderr) => {
          let output = "";

          if (stdout) {
            output += stdout.toString();
          }
          if (stderr) {
            if (output) output += "\n--- stderr ---\n";
            output += stderr.toString();
          }

          if (error) {
            if (!output) {
              output = error.message;
            }
            if (error.killed) {
              output += `\n\nCommand timed out after ${timeout / 1000}s`;
            }
          }

          if (!output) {
            output = "(no output)";
          }

          output = truncateOutput(output, MAX_OUTPUT_LENGTH);

          logger.log(
            `Command finished: ${args.command} (exit: ${error?.code ?? "ok"})`,
          );

          ctx.onXmlComplete(
            `<dyad-terminal command="${escapeXmlAttr(args.command)}" exit_code="${escapeXmlAttr(String(error?.code ?? 0))}">\n${escapeXmlContent(output)}\n</dyad-terminal>`,
          );

          resolve(output);
        },
      );

      child.on("error", (err) => {
        const msg = `Failed to start command: ${err.message}`;
        ctx.onXmlComplete(
          `<dyad-terminal command="${escapeXmlAttr(args.command)}" exit_code="-1">\n${escapeXmlContent(msg)}\n</dyad-terminal>`,
        );
        resolve(msg);
      });
    });
  },
};
