import { z } from "zod";
import log from "electron-log";
import { spawn } from "node:child_process";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";
import { extractCodebase } from "../../../../../../utils/codebase";
import { engineFetch } from "./engine_fetch";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { readSettings } from "@/main/settings";
import { isCodeExplorerReady } from "@/ipc/processors/code_explorer";
import {
  filterDyadInternalFiles,
  resolveTargetAppPath,
} from "./resolve_app_context";
import {
  getRgExecutablePath,
  MAX_FILE_SEARCH_SIZE,
  RIPGREP_EXCLUDED_GLOBS,
} from "@/ipc/utils/ripgrep_utils";

const logger = log.scope("code_search");

const codeSearchSchema = z.object({
  query: z.string().describe("Search query to find relevant files"),
  app_name: z
    .string()
    .optional()
    .describe(
      "Optional. Name of a referenced app (from `@app:Name` mentions in the user's prompt) to search in instead of the current app. Omit to search the current app.",
    ),
});

const FileContextSchema = z.object({
  path: z.string(),
  content: z.string(),
});

const codeSearchResponseSchema = z.object({
  relevantFiles: z.array(z.string()).describe("Paths of relevant files"),
});

type CodeSearchArgs = z.infer<typeof codeSearchSchema>;

function buildCodeSearchAttributes(args: Partial<CodeSearchArgs>) {
  const queryAttr = args.query ? ` query="${escapeXmlAttr(args.query)}"` : "";
  const appNameAttr = args.app_name
    ? ` app_name="${escapeXmlAttr(args.app_name)}"`
    : "";
  return `${queryAttr}${appNameAttr}`;
}

interface RipgrepMatch {
  path: string;
  lineNumber: number;
  lineText: string;
}

async function runRipgrepForTerm({
  appPath,
  term,
}: {
  appPath: string;
  term: string;
}): Promise<RipgrepMatch[]> {
  return new Promise((resolve, reject) => {
    const results: RipgrepMatch[] = [];
    const args: string[] = [
      "--json",
      "--no-config",
      "--max-filesize",
      `${MAX_FILE_SEARCH_SIZE}`,
      "--ignore-case",
      "--fixed-strings",
    ];

    const exclusionGlobs = RIPGREP_EXCLUDED_GLOBS;
    args.push(...exclusionGlobs.flatMap((glob) => ["--glob", glob]));
    args.push("--glob", "!.dyad/**");
    args.push("--", term, ".");

    const rg = spawn(getRgExecutablePath(), args, { cwd: appPath });
    let buffer = "";
    let stderr = "";

    rg.stdout.on("data", (data) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type !== "match" || !event.data) continue;

          const matchPath = event.data.path?.text as string;
          if (!matchPath) continue;

          const lineText = event.data.lines?.text as string;
          const lineNumber = event.data.line_number as number;

          if (typeof lineText !== "string" || typeof lineNumber !== "number")
            continue;

          const normalizedPath = matchPath
            .replace(/\\/g, "/")
            .replace(/^\.\//, "");

          if (
            normalizedPath.endsWith(".png") ||
            normalizedPath.endsWith(".jpg") ||
            normalizedPath.endsWith(".jpeg") ||
            normalizedPath.endsWith(".gif") ||
            normalizedPath.endsWith(".svg") ||
            normalizedPath.endsWith(".ico") ||
            normalizedPath.endsWith(".woff") ||
            normalizedPath.endsWith(".woff2") ||
            normalizedPath.endsWith(".ttf") ||
            normalizedPath.endsWith(".eot") ||
            normalizedPath.endsWith(".map") ||
            normalizedPath.endsWith(".lock") ||
            normalizedPath.includes("node_modules") ||
            normalizedPath.includes(".dyad/")
          ) {
            continue;
          }

          results.push({
            path: normalizedPath,
            lineNumber,
            lineText: lineText.replace(/\r?\n$/, ""),
          });
        } catch {
          // Skip malformed JSON lines
        }
      }
    });

    rg.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    rg.on("close", (code) => {
      if (code !== 0 && code !== 1) {
        reject(
          new Error(`ripgrep exited with code ${code}: ${stderr.slice(0, 200)}`),
        );
        return;
      }
      resolve(results);
    });

    rg.on("error", (error) => {
      reject(error);
    });
  });
}

function extractSearchTerms(query: string): string[] {
  const stopWords = new Set([
    "the",
    "a",
    "an",
    "is",
    "are",
    "was",
    "were",
    "be",
    "been",
    "being",
    "have",
    "has",
    "had",
    "do",
    "does",
    "did",
    "will",
    "would",
    "could",
    "should",
    "may",
    "might",
    "shall",
    "can",
    "to",
    "of",
    "in",
    "for",
    "on",
    "with",
    "at",
    "by",
    "from",
    "as",
    "into",
    "through",
    "during",
    "before",
    "after",
    "above",
    "below",
    "between",
    "and",
    "but",
    "or",
    "nor",
    "not",
    "so",
    "yet",
    "both",
    "either",
    "neither",
    "each",
    "every",
    "all",
    "any",
    "few",
    "more",
    "most",
    "other",
    "some",
    "such",
    "no",
    "only",
    "own",
    "same",
    "than",
    "too",
    "very",
    "just",
    "that",
    "this",
    "it",
    "its",
    "they",
    "them",
    "their",
    "what",
    "which",
    "who",
    "whom",
    "where",
    "when",
    "why",
    "how",
  ]);

  const camelCaseTerms: string[] = [];
  const plainTerms: string[] = [];

  const words = query
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9_\s]/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1);

  for (const word of words) {
    if (!stopWords.has(word)) {
      plainTerms.push(word);
    }
  }

  const originalWords = query.split(/\s+/).filter((w) => w.length > 1);
  for (const word of originalWords) {
    if (/[A-Z]/.test(word) && word.length > 3) {
      camelCaseTerms.push(word);
    }
  }

  const allTerms = [...new Set([...camelCaseTerms, ...plainTerms])];

  if (allTerms.length === 0) {
    return [query.trim()];
  }

  return allTerms;
}

async function localCodeSearch(
  query: string,
  appPath: string,
): Promise<string[]> {
  const terms = extractSearchTerms(query);
  logger.log(`Local search terms: ${terms.join(", ")}`);

  const fileMatchCounts = new Map<
    string,
    { count: number; terms: string[] }
  >();

  const searchPromises = terms.map(async (term) => {
    try {
      const matches = await runRipgrepForTerm({ appPath, term });
      return { term, matches };
    } catch (error) {
      logger.warn(`Search for term "${term}" failed:`, error);
      return { term, matches: [] as RipgrepMatch[] };
    }
  });

  const results = await Promise.all(searchPromises);

  for (const { term, matches } of results) {
    for (const match of matches) {
      const existing = fileMatchCounts.get(match.path);
      if (existing) {
        existing.count++;
        if (!existing.terms.includes(term)) {
          existing.terms.push(term);
        }
      } else {
        fileMatchCounts.set(match.path, {
          count: 1,
          terms: [term],
        });
      }
    }
  }

  const sortedFiles = [...fileMatchCounts.entries()]
    .sort((a, b) => {
      if (b[1].terms.length !== a[1].terms.length) {
        return b[1].terms.length - a[1].terms.length;
      }
      return b[1].count - a[1].count;
    })
    .slice(0, 20)
    .map(([path]) => path);

  return sortedFiles;
}

async function callCodeSearch(
  params: {
    query: string;
    app_name?: string;
    filesContext: z.infer<typeof FileContextSchema>[];
  },
  ctx: AgentContext,
): Promise<string[]> {
  ctx.onXmlStream(
    `<dyad-code-search${buildCodeSearchAttributes({
      query: params.query,
      app_name: params.app_name,
    })}>`,
  );

  const response = await engineFetch(ctx, "/tools/code-search", {
    method: "POST",
    body: JSON.stringify({
      query: params.query,
      filesContext: params.filesContext,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new DyadError(
      `Code search failed: ${response.status} ${response.statusText} - ${errorText}`,
      DyadErrorKind.External,
    );
  }

  const data = codeSearchResponseSchema.parse(await response.json());
  return data.relevantFiles;
}

const DESCRIPTION = `Search the codebase semantically to find files relevant to a query. Use this tool when you need to discover which files contain code related to a specific concept, feature, or functionality. Returns a list of file paths that are most relevant to the search query.

### When to Use This Tool

- Explore unfamiliar codebases
- Ask "how / where / what" questions to understand behavior
- Find code by meaning rather than exact text

### When NOT to Use

Skip this tool for:
1. Exact text matches (use \`grep\`)
2. Reading known files (use \`read_file\`)
3. Simple symbol lookups (use \`grep\`)
`;

export const codeSearchTool: ToolDefinition<CodeSearchArgs> = {
  name: "code_search",
  description: DESCRIPTION,
  inputSchema: codeSearchSchema,
  defaultConsent: "always",
  usesEngineEndpoint: true,

  isEnabled: (ctx) => {
    if (ctx.freeLocalAgentMode) {
      return true;
    }
    return (
      ctx.isDyadPro &&
      !(readSettings().enableCodeExplorer && isCodeExplorerReady(ctx.appPath))
    );
  },

  getConsentPreview: (args) =>
    args.app_name
      ? `Search for "${args.query}" (app: ${args.app_name})`
      : `Search for "${args.query}"`,

  buildXml: (args, isComplete) => {
    if (!args.query) return undefined;
    if (isComplete) return undefined;
    return `<dyad-code-search${buildCodeSearchAttributes(args)}>Searching...`;
  },

  execute: async (args, ctx: AgentContext) => {
    logger.log(`Executing code search: ${args.query}`);
    const targetAppPath = resolveTargetAppPath(ctx, args.app_name);

    let relevantFiles: string[];

    if (ctx.freeLocalAgentMode) {
      relevantFiles = await localCodeSearch(args.query, targetAppPath);
    } else {
      const { files } = await extractCodebase({
        appPath: targetAppPath,
        chatContext: {
          contextPaths: [],
          smartContextAutoIncludes: [],
          excludePaths: [],
        },
      });

      const filteredFiles = filterDyadInternalFiles(files, args.app_name);

      const filesContext = filteredFiles.map((file) => ({
        path: file.path,
        content: file.content,
      }));

      logger.log(
        `Searching ${filesContext.length} files for query: "${args.query}"`,
      );

      relevantFiles = await callCodeSearch(
        {
          query: args.query,
          app_name: args.app_name,
          filesContext,
        },
        ctx,
      );
    }

    const resultText =
      relevantFiles.length === 0
        ? "No relevant files found."
        : relevantFiles.map((f) => ` - ${f}`).join("\n");

    ctx.onXmlComplete(
      `<dyad-code-search${buildCodeSearchAttributes(args)}>${escapeXmlContent(resultText)}</dyad-code-search>`,
    );

    logger.log(`Code search completed for query: ${args.query}`);

    if (relevantFiles.length === 0) {
      return "No relevant files found for the given query.";
    }

    return `Found ${relevantFiles.length} relevant file(s):\n${resultText}`;
  },
};
