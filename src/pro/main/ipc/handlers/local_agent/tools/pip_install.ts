import { z } from "zod";
import { exec } from "node:child_process";
import log from "electron-log";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";

const logger = log.scope("pip_install");

const MAX_OUTPUT_LENGTH = 10000;

const pipInstallSchema = z.object({
  packages: z
    .array(z.string())
    .min(1)
    .max(20)
    .describe("List of package names to install (e.g. ['requests', 'flask'])"),
  upgrade: z
    .boolean()
    .optional()
    .describe("Upgrade packages to latest version"),
  requirements_file: z
    .string()
    .optional()
    .describe("Path to requirements.txt file to install from"),
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

async function findPip(): Promise<string> {
  const candidates = ["pip", "pip3", "py -m pip"];
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
  return "pip";
}

export const pipInstallTool: ToolDefinition<
  z.infer<typeof pipInstallSchema>
> = {
  name: "pip_install",
  description: `Install Python packages using pip.

Use this to:
- Install new dependencies (requests, flask, django, etc.)
- Install from requirements.txt
- Upgrade packages

Examples:
- Install: ["requests", "flask"]
- Install from file: requirements.txt`,
  inputSchema: pipInstallSchema,
  defaultConsent: "ask",

  getConsentPreview: (args) => {
    if (args.requirements_file) {
      return `Install from ${args.requirements_file}`;
    }
    return `Install: ${args.packages.join(", ")}`;
  },

  buildXml: (args, isComplete) => {
    let xml = `<dyad-pip`;
    if (args.requirements_file) {
      xml += ` requirements="${escapeXmlAttr(args.requirements_file)}"`;
    }
    xml += ">";
    if (isComplete) {
      xml += "</dyad-pip>";
    }
    return xml;
  },

  execute: async (args, ctx: AgentContext) => {
    const pipCmd = await findPip();

    let command: string;
    if (args.requirements_file) {
      command = `${pipCmd} install -r "${args.requirements_file}"`;
    } else {
      const upgradeFlag = args.upgrade ? " --upgrade" : "";
      command = `${pipCmd} install${upgradeFlag} ${args.packages.join(" ")}`;
    }

    logger.log(`Running: ${command}`);

    ctx.onXmlStream(
      `<dyad-status title="${escapeXmlAttr(`Installing: ${args.requirements_file ?? args.packages.join(", ")}`)}"></dyad-status>`,
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
            if (output) output += "\n--- stderr ---\n";
            output += stderr.toString();
          }

          if (error) {
            if (!output) output = error.message;
            if (error.killed) {
              output += "\n\nCommand timed out after 120s";
            }
          }

          if (!output) output = "(no output)";

          output = truncateOutput(output, MAX_OUTPUT_LENGTH);

          const success = !error || output.includes("Successfully installed");

          ctx.onXmlComplete(
            `<dyad-pip success="${success}" exit_code="${escapeXmlAttr(String(error?.code ?? 0))}">\n${escapeXmlContent(output)}\n</dyad-pip>`,
          );

          resolve(output);
        },
      );

      child.on("error", (err) => {
        const msg = `Failed to start pip: ${err.message}`;
        ctx.onXmlComplete(
          `<dyad-pip success="false" exit_code="-1">\n${escapeXmlContent(msg)}\n</dyad-pip>`,
        );
        resolve(msg);
      });
    });
  },
};
