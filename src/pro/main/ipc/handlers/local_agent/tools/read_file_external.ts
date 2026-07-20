import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import log from "electron-log";
import { ToolDefinition, AgentContext, escapeXmlAttr } from "./types";

const logger = log.scope("read_file_external");

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB limit

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".css",
  ".scss",
  ".html",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".env",
  ".gitignore",
  ".npmrc",
  ".eslintrc",
  ".prettierrc",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".bat",
  ".cmd",
  ".ps1",
  ".sql",
  ".graphql",
  ".proto",
  ".swift",
  ".kt",
  ".scala",
  ".ex",
  ".exs",
  ".erl",
  ".hs",
  ".lua",
  ".r",
  ".R",
  ".vue",
  ".svelte",
  ".astro",
  ".mdx",
  ".csv",
  ".tsv",
  ".log",
  ".config",
  ".conf",
  ".ini",
  ".cfg",
]);

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".svg",
  ".webp",
  ".ico",
  ".tiff",
  ".tif",
]);

const BINARY_EXTENSIONS = new Set([
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".zip",
  ".gz",
  ".tar",
  ".rar",
  ".7z",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".node",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
]);

function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext);
}

function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

const readExternalFileSchema = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      "Absolute file path to read (e.g. 'C:\\Users\\me\\Desktop\\logo.png' or '/home/user/file.txt')",
    ),
  start_line_one_indexed: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("The one-indexed line number to start reading from (inclusive)"),
  end_line_one_indexed_inclusive: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("The one-indexed line number to end reading at (inclusive)"),
  encoding: z
    .enum(["utf8", "binary"])
    .optional()
    .describe("File encoding (default: utf8 for text files)"),
});

export const readExternalFileTool: ToolDefinition<
  z.infer<typeof readExternalFileSchema>
> = {
  name: "read_file_external",
  description: `Read a file from ANY location on the user's computer using an absolute path.

Use this tool when you need to access files outside the project directory, such as:
- Logos or images from the user's Desktop or Documents
- Config files from other projects
- Any file the user asks you to read

For text files: returns the content with optional line ranges.
For image files: returns metadata (size, dimensions info) and confirms the path.
For binary files: returns file info (size, type) without content.

WARNING: Only read files the user explicitly asks you to read.`,
  inputSchema: readExternalFileSchema,
  defaultConsent: "ask",

  getConsentPreview: (args) => `Read external file: ${args.path}`,

  buildXml: (args, _isComplete) => {
    if (!args.path) return undefined;
    return `<dyad-read-external path="${escapeXmlAttr(args.path)}"></dyad-read-external>`;
  },

  execute: async (args, ctx: AgentContext) => {
    const filePath = args.path;

    // Normalize Windows paths
    const normalizedPath = filePath.replace(/\//g, path.sep);

    logger.log(`Reading external file: ${normalizedPath}`);

    try {
      // Check if file exists
      const stat = await fs.stat(normalizedPath);

      if (!stat.isFile()) {
        return `Error: "${normalizedPath}" is not a file (it's a directory or other type)`;
      }

      // Check file size
      if (stat.size > MAX_FILE_SIZE) {
        return `Error: File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB). Maximum allowed: ${MAX_FILE_SIZE / 1024 / 1024}MB`;
      }

      // Handle image files
      if (isImageFile(normalizedPath)) {
        const ext = path.extname(normalizedPath).toLowerCase();
        const sizeKB = (stat.size / 1024).toFixed(1);
        const modified = stat.mtime.toISOString();

        ctx.onXmlComplete(
          `<dyad-read-external path="${escapeXmlAttr(normalizedPath)}" type="image" size="${sizeKB}KB" modified="${modified}" />\n</dyad-read-external>`,
        );

        return `Image file found:
- Path: ${normalizedPath}
- Type: ${ext}
- Size: ${sizeKB}KB
- Modified: ${modified}

To use this image in your project, copy it to the project directory first.`;
      }

      // Handle binary files
      if (isBinaryFile(normalizedPath)) {
        const ext = path.extname(normalizedPath).toLowerCase();
        const sizeKB = (stat.size / 1024).toFixed(1);
        const modified = stat.mtime.toISOString();

        ctx.onXmlComplete(
          `<dyad-read-external path="${escapeXmlAttr(normalizedPath)}" type="binary" ext="${ext}" size="${sizeKB}KB" modified="${modified}" />\n</dyad-read-external>`,
        );

        return `Binary file found:
- Path: ${normalizedPath}
- Type: ${ext}
- Size: ${sizeKB}KB
- Modified: ${modified}

Cannot display binary content. Copy it to the project if needed.`;
      }

      // Read text file
      let content = await fs.readFile(normalizedPath, "utf8");
      const originalLength = content.length;

      // Apply line range if specified
      if (
        args.start_line_one_indexed != null ||
        args.end_line_one_indexed_inclusive != null
      ) {
        const lines = content.split("\n");
        const start = (args.start_line_one_indexed ?? 1) - 1;
        const end = args.end_line_one_indexed_inclusive ?? lines.length;
        content = lines.slice(start, end).join("\n");
      }

      // Truncate if too long
      const MAX_CONTENT = 50000;
      let truncated = false;
      if (content.length > MAX_CONTENT) {
        content = content.slice(0, MAX_CONTENT) + "\n\n... [truncated]";
        truncated = true;
      }

      const modified = stat.mtime.toISOString();
      const lines = content.split("\n").length;

      ctx.onXmlComplete(
        `<dyad-read-external path="${escapeXmlAttr(normalizedPath)}" type="text" lines="${lines}" size="${originalLength}" modified="${modified}" truncated="${truncated}" />\n</dyad-read-external>`,
      );

      return content;
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return `Error: File not found: "${normalizedPath}"`;
      }
      if (error.code === "EACCES") {
        return `Error: Permission denied: "${normalizedPath}"`;
      }
      if (error.code === "EPERM") {
        return `Error: Access denied: "${normalizedPath}" (may be a system file)`;
      }
      return `Error reading file: ${error.message}`;
    }
  },
};
