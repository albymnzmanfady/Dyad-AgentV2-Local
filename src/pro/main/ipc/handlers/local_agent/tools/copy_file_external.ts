import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
} from "./types";

const logger = log.scope("copy_file_external");

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB for copies

const copyExternalFileSchema = z.object({
  source: z
    .string()
    .min(1)
    .describe(
      "Absolute source file path (e.g. 'C:\\Users\\me\\Desktop\\logo.png')",
    ),
  destination: z
    .string()
    .min(1)
    .describe(
      "Destination path. Can be absolute or relative to project (e.g. 'public/images/logo.png')",
    ),
});

export const copyExternalFileTool: ToolDefinition<
  z.infer<typeof copyExternalFileSchema>
> = {
  name: "copy_file_external",
  description: `Copy a file from ANY location on the user's computer to the project or another location.

Use this to:
- Import images/logos from Desktop/Documents to the project
- Copy config files between projects
- Move files to specific locations

The source can be any absolute path. The destination can be:
- A project-relative path (e.g. 'public/images/photo.jpg')
- An absolute path (e.g. 'D:\\backup\\file.txt')`,
  inputSchema: copyExternalFileSchema,
  defaultConsent: "ask",

  getConsentPreview: (args) =>
    `Copy: ${path.basename(args.source)} → ${args.destination}`,

  buildXml: (args, _isComplete) => {
    if (!args.source) return undefined;
    return `<dyad-copy-external source="${escapeXmlAttr(args.source)}" destination="${escapeXmlAttr(args.destination)}"></dyad-copy-external>`;
  },

  execute: async (args, ctx: AgentContext) => {
    const sourcePath = args.source.replace(/\//g, path.sep);
    const destRelative = args.destination;

    logger.log(`Copying: ${sourcePath} → ${destRelative}`);

    try {
      // Check source exists
      const stat = await fs.stat(sourcePath);

      if (!stat.isFile()) {
        return `Error: Source "${sourcePath}" is not a file`;
      }

      if (stat.size > MAX_FILE_SIZE) {
        return `Error: File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Max: ${MAX_FILE_SIZE / 1024 / 1024}MB`;
      }

      // Determine destination path
      let destPath: string;
      if (path.isAbsolute(destRelative)) {
        destPath = destRelative;
      } else {
        destPath = path.join(ctx.appPath, destRelative);
      }

      // Ensure destination directory exists
      const destDir = path.dirname(destPath);
      await fs.mkdir(destDir, { recursive: true });

      // Copy the file
      await fs.copyFile(sourcePath, destPath);

      const sizeKB = (stat.size / 1024).toFixed(1);
      const message = `Successfully copied ${path.basename(sourcePath)} (${sizeKB}KB) to ${destRelative}`;

      ctx.onXmlComplete(
        `<dyad-copy-external source="${escapeXmlAttr(sourcePath)}" destination="${escapeXmlAttr(destPath)}" size="${sizeKB}KB" />\n</dyad-copy-external>`,
      );

      return message;
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return `Error: Source file not found: "${sourcePath}"`;
      }
      if (error.code === "EACCES" || error.code === "EPERM") {
        return `Error: Permission denied: "${error.path}"`;
      }
      return `Error copying file: ${error.message}`;
    }
  },
};
