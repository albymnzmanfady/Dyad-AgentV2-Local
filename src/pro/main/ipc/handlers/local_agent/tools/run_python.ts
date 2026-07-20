import { z } from "zod";
import { exec } from "node:child_process";
import log from "electron-log";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";

const logger = log.scope("run_python");

const MAX_OUTPUT_LENGTH = 10000;
const DEFAULT_TIMEOUT_MS = 60000;

const runPythonSchema = z.object({
  script: z
    .string()
    .min(1)
    .max(50000)
    .describe(
      "Python code or script path to execute. Can be inline code or a .py file path.",
    ),
  args: z
    .array(z.string())
    .optional()
    .describe("Command-line arguments to pass to the script"),
  timeout: z
    .number()
    .int()
    .min(1000)
    .max(300000)
    .optional()
    .describe("Timeout in milliseconds (default: 60000)"),
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

async function findPython(): Promise<string> {
  const candidates = ["python", "python3", "py"];
  for (const cmd of candidates) {
    try {
      const result = await new Promise<boolean>((resolve) => {
        exec(`${cmd} --version`, { windowsHide: true }, (error) => {
          resolve(!error);
        });
      });
      if (result) return cmd;
    } catch {
      continue;
    }
  }
  return "python";
}

export const runPythonTool: ToolDefinition<z.infer<typeof runPythonSchema>> = {
  name: "run_python",
  description: `Execute Python code or a Python script file.

Use this to:
- Run Python scripts and see output
- Test code snippets
- Process data
- Run utility scripts

The code runs in the app's working directory with full Python access.
Use 'script' for inline code or file paths like 'scripts/process.py'.`,
  inputSchema: runPythonSchema,
  defaultConsent: "always",

  getConsentPreview: (args) => `Run Python: ${args.script.slice(0, 80)}...`,

  buildXml: (args, isComplete) => {
    let xml = `<dyad-python>`;
    if (isComplete) {
      xml += `</dyad-python>`;
    }
    return xml;
  },

  execute: async (args, ctx: AgentContext) => {
    const timeout = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, 300000);
    const pythonCmd = await findPython();

    // Check if it's a file path or inline code
    const isFilePath =
      args.script.endsWith(".py") ||
      args.script.startsWith("./") ||
      args.script.startsWith(".\\");

    let command: string;
    if (isFilePath) {
      const argStr = args.args?.join(" ") ?? "";
      command = `${pythonCmd} "${args.script}" ${argStr}`;
    } else {
      command = `${pythonCmd} -c "${args.script.replace(/"/g, '\\"')}"`;
    }

    logger.log(`Running Python: ${command}`);

    ctx.onXmlStream(
      `<dyad-status title="${escapeXmlAttr(`Running Python: ${args.script.slice(0, 60)}`)}"></dyad-status>`,
    );

    return new Promise<string>((resolve) => {
      const child = exec(
        command,
        {
          cwd: ctx.appPath,
          timeout,
          maxBuffer: 1024 * 1024 * 5,
          encoding: "utf8",
          windowsHide: true,
          env: { ...process.env, FORCE_COLOR: "0" },
        },
        (error, stdout, stderr) => {
          let output = "";

          if (stdout) output += stdout.toString();
          if (stderr) {
            if (output) output += "\n--- stderr ---\n";
            output += stderr.toString();
          }

          if (error) {
            if (!output) output = error.message;
            if (error.killed) {
              output += `\n\nCommand timed out after ${timeout / 1000}s`;
            }
          }

          if (!output) output = "(no output)";

          output = truncateOutput(output, MAX_OUTPUT_LENGTH);

          ctx.onXmlComplete(
            `<dyad-python exit_code="${escapeXmlAttr(String(error?.code ?? 0))}">\n${escapeXmlContent(output)}\n</dyad-python>`,
          );

          resolve(output);
        },
      );

      child.on("error", (err) => {
        const msg = `Failed to start Python: ${err.message}`;
        ctx.onXmlComplete(
          `<dyad-python exit_code="-1">\n${escapeXmlContent(msg)}\n</dyad-python>`,
        );
        resolve(msg);
      });
    });
  },
};
