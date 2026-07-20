import { z } from "zod";
import { exec } from "node:child_process";
import log from "electron-log";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";

const logger = log.scope("web_search_local");

const MAX_OUTPUT_LENGTH = 10000;

const webSearchLocalSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(500)
    .describe("Search query to find information"),
  num_results: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe("Number of results to return (default: 5)"),
});

function truncateOutput(output: string, maxLength: number): string {
  if (output.length <= maxLength) return output;
  return output.slice(0, maxLength) + "\n\n... [truncated]";
}

// Python script for DuckDuckGo search (no API key needed)
const SEARCH_SCRIPT = `
import sys
import json
import urllib.request
import urllib.parse
import re

def search_duckduckgo(query, num_results=5):
    """Search using DuckDuckGo HTML (no API key needed)."""
    try:
        # Use DuckDuckGo instant answer API
        encoded_query = urllib.parse.quote(query)
        url = f"https://api.duckduckgo.com/?q={encoded_query}&format=json&no_html=1&skip_disambig=1"
        
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })
        
        with urllib.request.urlopen(req, timeout=10) as response:
            data = json.loads(response.read().decode())
        
        results = []
        
        # Get abstract if available
        if data.get('Abstract'):
            results.append({
                'title': data.get('Heading', 'Result'),
                'snippet': data['Abstract'],
                'url': data.get('AbstractURL', '')
            })
        
        # Get related topics
        for topic in data.get('RelatedTopics', [])[:num_results]:
            if isinstance(topic, dict) and 'Text' in topic:
                results.append({
                    'title': topic.get('Text', '')[:100],
                    'snippet': topic.get('Text', ''),
                    'url': topic.get('FirstURL', '')
                })
            if len(results) >= num_results:
                break
        
        # If no results from API, try HTML search
        if not results:
            html_url = f"https://html.duckduckgo.com/html/?q={encoded_query}"
            req = urllib.request.Request(html_url, headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            })
            try:
                with urllib.request.urlopen(req, timeout=10) as response:
                    html = response.read().decode('utf-8', errors='ignore')
                
                # Extract results from HTML
                title_pattern = r'class="result__a"[^>]*>(.*?)</a>'
                snippet_pattern = r'class="result__snippet"[^>]*>(.*?)</span>'
                
                titles = re.findall(title_pattern, html, re.DOTALL)
                snippets = re.findall(snippet_pattern, html, re.DOTALL)
                
                for i, (title, snippet) in enumerate(zip(titles, snippets)):
                    if i >= num_results:
                        break
                    clean_title = re.sub(r'<[^>]+>', '', title).strip()
                    clean_snippet = re.sub(r'<[^>]+>', '', snippet).strip()
                    results.append({
                        'title': clean_title,
                        'snippet': clean_snippet,
                        'url': ''
                    })
            except:
                pass
        
        return results[:num_results] if results else [{'title': 'No results', 'snippet': 'Could not find results for: ' + query, 'url': ''}]
    
    except Exception as e:
        return [{'title': 'Search error', 'snippet': str(e), 'url': ''}]

def main():
    query = sys.argv[1] if len(sys.argv) > 1 else ''
    num_results = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    
    if not query:
        print(json.dumps({'error': 'No query provided'}))
        sys.exit(1)
    
    results = search_duckduckgo(query, num_results)
    print(json.dumps(results, indent=2))

if __name__ == '__main__':
    main()
`;

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

export const webSearchLocalTool: ToolDefinition<
  z.infer<typeof webSearchLocalSchema>
> = {
  name: "web_search_local",
  description: `Search the web using DuckDuckGo (no API key required).

Use this to:
- Find documentation and references
- Look up error messages
- Research best practices
- Find code examples
- Get up-to-date information

Results include title, snippet, and URL when available.`,
  inputSchema: webSearchLocalSchema,
  defaultConsent: "always",

  getConsentPreview: (args) => `Search: "${args.query}"`,

  buildXml: (args, isComplete) => {
    if (!args.query) return undefined;
    let xml = `<dyad-web-search query="${escapeXmlAttr(args.query)}"`;
    xml += ">";
    if (isComplete) {
      xml += "</dyad-web-search>";
    }
    return xml;
  },

  execute: async (args, ctx: AgentContext) => {
    const pythonCmd = await findPython();
    const scriptPath = require("node:path").join(
      ctx.appPath,
      "__dyad_search.py",
    );

    logger.log(`Searching: ${args.query}`);

    ctx.onXmlStream(
      `<dyad-status title="${escapeXmlAttr(`Searching: ${args.query}`)}"></dyad-status>`,
    );

    try {
      // Write search script
      await require("node:fs/promises").writeFile(
        scriptPath,
        SEARCH_SCRIPT,
        "utf8",
      );

      const numResults = args.num_results ?? 5;
      const command = `${pythonCmd} "${scriptPath}" "${args.query.replace(/"/g, '\\"')}" ${numResults}`;

      const result = await new Promise<string>((resolve) => {
        exec(
          command,
          {
            cwd: ctx.appPath,
            timeout: 30000,
            maxBuffer: 1024 * 1024,
            encoding: "utf8",
            windowsHide: true,
          },
          async (error, stdout, stderr) => {
            let output = stdout || stderr || "";
            if (error && !output) {
              output = error.message;
            }

            try {
              const results = JSON.parse(output);

              if (results.error) {
                output = `Search error: ${results.error}`;
              } else {
                let report = `## Search Results for "${args.query}"\n\n`;
                for (const r of results) {
                  report += `### ${r.title}\n`;
                  report += `${r.snippet}\n`;
                  if (r.url) report += `🔗 ${r.url}\n`;
                  report += "\n";
                }
                output = truncateOutput(report, MAX_OUTPUT_LENGTH);
              }
            } catch {
              output = truncateOutput(output, MAX_OUTPUT_LENGTH);
            }

            resolve(output);
          },
        );
      });

      ctx.onXmlComplete(
        `<dyad-web-search query="${escapeXmlAttr(args.query)}">\n${escapeXmlContent(result)}\n</dyad-web-search>`,
      );

      return result;
    } catch (error: any) {
      const msg = `Search failed: ${error.message}`;
      ctx.onXmlComplete(
        `<dyad-web-search query="${escapeXmlAttr(args.query)}">\n${escapeXmlContent(msg)}\n</dyad-web-search>`,
      );
      return msg;
    } finally {
      // Clean up
      try {
        await require("node:fs/promises").unlink(scriptPath);
      } catch {
        // Ignore
      }
    }
  },
};
