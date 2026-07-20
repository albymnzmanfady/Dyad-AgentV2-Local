import { z } from "zod";
import log from "electron-log";
import { ToolDefinition, escapeXmlContent, AgentContext } from "./types";
import { engineFetch } from "./engine_fetch";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";

const logger = log.scope("web_fetch");

function validateHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DyadError(`Invalid URL: ${url}`, DyadErrorKind.Validation);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `Unsupported URL scheme "${parsed.protocol}" — only http and https are allowed`,
    );
  }
}

const MAX_CONTENT_LENGTH = 80_000;

function truncateContent(value: string): string {
  if (value.length <= MAX_CONTENT_LENGTH) return value;
  return `${value.slice(0, MAX_CONTENT_LENGTH)}\n\n<!-- truncated -->`;
}

function htmlToMarkdown(html: string): string {
  let markdown = html;

  // Remove script and style elements
  markdown = markdown.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
  markdown = markdown.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");

  // Remove HTML comments
  markdown = markdown.replace(/<!--[\s\S]*?-->/g, "");

  // Convert headings
  markdown = markdown.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "# $1\n\n");
  markdown = markdown.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "## $1\n\n");
  markdown = markdown.replace(/<h3[^>]*>(.*?)<\/h3>/gi, "### $1\n\n");
  markdown = markdown.replace(/<h4[^>]*>(.*?)<\/h4>/gi, "#### $1\n\n");
  markdown = markdown.replace(/<h5[^>]*>(.*?)<\/h5>/gi, "##### $1\n\n");
  markdown = markdown.replace(/<h6[^>]*>(.*?)<\/h6>/gi, "###### $1\n\n");

  // Convert paragraphs
  markdown = markdown.replace(/<p[^>]*>(.*?)<\/p>/gi, "$1\n\n");

  // Convert line breaks
  markdown = markdown.replace(/<br\s*\/?>/gi, "\n");

  // Convert bold and italic
  markdown = markdown.replace(/<strong[^>]*>(.*?)<\/strong>/gi, "**$1**");
  markdown = markdown.replace(/<b[^>]*>(.*?)<\/b>/gi, "**$1**");
  markdown = markdown.replace(/<em[^>]*>(.*?)<\/em>/gi, "*$1*");
  markdown = markdown.replace(/<i[^>]*>(.*?)<\/i>/gi, "*$1*");

  // Convert links
  markdown = markdown.replace(
    /<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi,
    "[$2]($1)",
  );

  // Convert code blocks
  markdown = markdown.replace(
    /<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
    "```\n$1\n```\n",
  );
  markdown = markdown.replace(/<code[^>]*>(.*?)<\/code>/gi, "`$1`");

  // Convert lists
  markdown = markdown.replace(/<li[^>]*>(.*?)<\/li>/gi, "- $1\n");

  // Remove remaining HTML tags
  markdown = markdown.replace(/<[^>]+>/g, "");

  // Decode HTML entities
  markdown = markdown.replace(/&amp;/g, "&");
  markdown = markdown.replace(/&lt;/g, "<");
  markdown = markdown.replace(/&gt;/g, ">");
  markdown = markdown.replace(/&quot;/g, '"');
  markdown = markdown.replace(/&#39;/g, "'");
  markdown = markdown.replace(/&nbsp;/g, " ");

  // Clean up whitespace
  markdown = markdown.replace(/\n{3,}/g, "\n\n");
  markdown = markdown.trim();

  return markdown;
}

async function localWebFetch(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new DyadError(
      `HTTP ${response.status}: ${response.statusText}`,
      DyadErrorKind.External,
    );
  }

  const html = await response.text();
  const markdown = htmlToMarkdown(html);

  return markdown;
}

const webFetchSchema = z.object({
  url: z.string().describe("URL to fetch content from"),
});

const webFetchResponseSchema = z.object({
  rootUrl: z.string(),
  markdown: z.string().optional(),
  pages: z.array(
    z.object({
      url: z.string(),
      markdown: z.string(),
    }),
  ),
});

const DESCRIPTION = `Fetch and read the content of a web page as markdown given its URL.

### When to Use This Tool
Use this tool when the user's message contains a URL (or domain name) and they want to:
- **Read** the page's content (e.g. documentation, blog post, article)
- **Reference** information from the page (e.g. API docs, tutorials, guides)
- **Extract** data or context from a live web page to inform their code
- **Follow a link** someone shared to understand its contents

Examples:
- "Use the docs at docs.example.com/api to set up the client"
- "What does this page say? https://example.com/blog/post"
- "Follow the guide at example.com/tutorial"

### When NOT to Use This Tool
- The user wants to **visually clone or replicate** a website → use \`web_crawl\` instead
- The user needs to **search the web** for information without a specific URL → use \`web_search\` instead
`;

async function callWebFetch(
  url: string,
  ctx: Pick<AgentContext, "dyadRequestId">,
): Promise<z.infer<typeof webFetchResponseSchema>> {
  const response = await engineFetch(ctx, "/tools/web-crawl", {
    method: "POST",
    body: JSON.stringify({ url, markdownOnly: true }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Web fetch failed: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  const data = webFetchResponseSchema.parse(await response.json());
  return data;
}

export const webFetchTool: ToolDefinition<z.infer<typeof webFetchSchema>> = {
  name: "web_fetch",
  description: DESCRIPTION,
  inputSchema: webFetchSchema,
  defaultConsent: "always",
  usesEngineEndpoint: true,

  isEnabled: (ctx) => ctx.isDyadPro || ctx.freeLocalAgentMode,

  getConsentPreview: (args) => `Fetch URL: "${args.url}"`,

  buildXml: (args, isComplete) => {
    if (!args.url) return undefined;
    if (isComplete) return undefined;
    return `<dyad-web-fetch>${escapeXmlContent(args.url)}`;
  },

  execute: async (args, ctx) => {
    logger.log(`Executing web fetch: ${args.url}`);

    validateHttpUrl(args.url);

    ctx.onXmlStream(`<dyad-web-fetch>${escapeXmlContent(args.url)}`);

    try {
      let content: string;

      if (ctx.freeLocalAgentMode) {
        content = await localWebFetch(args.url);
      } else {
        const result = await callWebFetch(args.url, ctx);

        if (!result) {
          throw new DyadError(
            "Web fetch returned no results",
            DyadErrorKind.NotFound,
          );
        }

        content = result.pages
          .map((page) => `## ${page.url}\n\n${page.markdown}`)
          .join("\n\n---\n\n");
      }

      if (!content) {
        throw new DyadError(
          "No content available from web fetch",
          DyadErrorKind.NotFound,
        );
      }

      logger.log(`Web fetch completed for URL: ${args.url}`);

      ctx.onXmlComplete(
        `<dyad-web-fetch>${escapeXmlContent(args.url)}</dyad-web-fetch>`,
      );

      return truncateContent(content);
    } catch (error) {
      ctx.onXmlComplete(
        `<dyad-web-fetch>${escapeXmlContent(args.url)}</dyad-web-fetch>`,
      );
      throw error;
    }
  },
};
