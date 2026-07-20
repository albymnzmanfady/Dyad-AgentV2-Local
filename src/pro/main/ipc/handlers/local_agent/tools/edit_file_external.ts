import { z } from "zod";
import fs from "node:fs/promises";
import log from "electron-log";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";

const logger = log.scope("edit_file_external");

const MAX_FILE_SIZE = 5 * 1024 * 1024;

const editExternalFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "Absolute file path to edit (e.g. 'C:\\Users\\me\\Desktop\\config.json')",
    ),
  old_string: z
    .string()
    .min(1)
    .describe("The text to find and replace"),
  new_string: z
    .string()
    .describe("The replacement text"),
});

export const editExternalFileTool: ToolDefinition<
  z.infer<typeof editExternalFileSchema>
> = {
  name: "edit_file_external",
  description: `Edit a file at ANY location on the user's computer using search and replace.

Use this when you need to modify files outside the project directory, such as:
- Config files from other projects
- Files on Desktop or Documents
- Any file the user asks you to edit

WARNING: Only edit files the user explicitly asks you to edit. Always show what you're changing.`,
  inputSchema: editExternalFileSchema,
  defaultConsent: "ask",

  getConsentPreview: (args) => `Edit external file: ${args.path}`,

  buildXml: (args, _isComplete) => {
    if (!args.path) return undefined;
    return `<dyad-edit-external path="${escapeXmlAttr(args.path)}"></dyad-edit-external>`;
  },

  execute: async (args, ctx: AgentContext) => {
    const filePath = args.path.replace(/\//g, require("node:path").sep);

    logger.log(`Editing external file: ${filePath}`);

    try {
      const stat = await fs.stat(filePath);

      if (!stat.isFile()) {
        return `Error: "${filePath}" is not a file`;
      }

      if (stat.size > MAX_FILE_SIZE) {
        return `Error: File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB)`;
      }

      const content = await fs.readFile(filePath, "utf8");

      if (!content.includes(args.old_string)) {
        return `Error: Could not find the specified text in "${filePath}"`;
      }

      const count = content.split(args.old_string).length - 1;
      if (count > 1) {
        return `Error: Found ${count} occurrences of the search text. Please provide more unique context.`;
      }

      const newContent = content.replace(args.old_string, args.new_string);
      await fs.writeFile(filePath, newContent, "utf8");

      const message = `Successfully edited ${filePath}`;
      ctx.onXmlComplete(
        `<dyad-edit-external path="${escapeXmlAttr(filePath)}" success="true" />\n</dyad-edit-external>`,
      );

      return message;
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return `Error: File not found: "${filePath}"`;
      }
      if (error.code === "EACCES" || error.code === "EPERM") {
        return `Error: Permission denied: "${filePath}"`;
      }
      return `Error editing file: ${error.message}`;
    }
  },
};
