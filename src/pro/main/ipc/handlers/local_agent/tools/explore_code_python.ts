import { z } from "zod";
import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";
import {
  ToolDefinition,
  AgentContext,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";

const logger = log.scope("explore_code_python");

const MAX_OUTPUT_LENGTH = 15000;

const exploreCodePythonSchema = z.object({
  query: z
    .string()
    .min(1)
    .describe(
      "What to search for: function name, class, variable, or concept",
    ),
  intent: z
    .enum(["explain", "locate", "edit", "debug"])
    .optional()
    .describe(
      "What you will do with the result: explain, locate, edit, or debug",
    ),
  file_path: z
    .string()
    .optional()
    .describe("Specific file to explore (optional)"),
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

// Python script to explore code using Jedi (if available) or fallback to grep
const EXPLORER_SCRIPT = `
import sys
import os
import json

def find_python_files(root_dir, max_files=500):
    """Find all Python files in directory."""
    py_files = []
    for root, dirs, files in os.walk(root_dir):
        # Skip common non-source directories
        dirs[:] = [d for d in dirs if d not in [
            '.git', '__pycache__', 'node_modules', '.venv', 'venv',
            'env', '.env', '.tox', '.mypy_cache', '.pytest_cache',
            'dist', 'build', '*.egg-info'
        ]]
        for f in files:
            if f.endswith('.py'):
                py_files.append(os.path.join(root, f))
                if len(py_files) >= max_files:
                    return py_files
    return py_files

def search_in_files(files, query):
    """Search for query in Python files."""
    results = []
    query_lower = query.lower()
    for filepath in files:
        try:
            with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
                lines = f.readlines()
                for i, line in enumerate(lines, 1):
                    if query_lower in line.lower():
                        results.append({
                            'file': filepath,
                            'line': i,
                            'content': line.rstrip()
                        })
                        if len(results) >= 50:
                            return results
        except:
            continue
    return results

def analyze_with_jedi(root_dir, query):
    """Try to use Jedi for code analysis."""
    try:
        import jedi
        # Try to find references
        script = jedi.Script(path=root_dir)
        
        # Try goto_definition
        try:
            defs = script.goto_definitions(query, 1, 1)
            if defs:
                return {
                    'type': 'definition',
                    'results': [{
                        'file': d.module_path,
                        'line': d.line,
                        'name': d.name,
                        'type': d.type,
                        'description': str(d)
                    } for d in defs[:10]]
                }
        except:
            pass
        
        # Try completions
        try:
            completions = script.complete(query, 1, len(query))
            if completions:
                return {
                    'type': 'completions',
                    'results': [{
                        'name': c.name,
                        'type': c.type,
                        'description': c.description
                    } for c in completions[:20]]
                }
        except:
            pass
    except ImportError:
        pass
    return None

def main():
    root_dir = sys.argv[1] if len(sys.argv) > 1 else '.'
    query = sys.argv[2] if len(sys.argv) > 2 else ''
    
    if not query:
        print("Error: No query provided")
        sys.exit(1)
    
    # Try Jedi first
    jedi_result = analyze_with_jedi(root_dir, query)
    if jedi_result:
        print(json.dumps(jedi_result, indent=2))
        return
    
    # Fallback to file search
    py_files = find_python_files(root_dir)
    results = search_in_files(py_files, query)
    
    output = {
        'type': 'search',
        'query': query,
        'files_scanned': len(py_files),
        'matches': len(results),
        'results': results
    }
    print(json.dumps(output, indent=2))

if __name__ == '__main__':
    main()
`;

export const exploreCodePythonTool: ToolDefinition<
  z.infer<typeof exploreCodePythonSchema>
> = {
  name: "explore_code_python",
  description: `Explore Python code to find definitions, references, and understand code structure.

Use this to:
- Find where functions/classes are defined
- Understand code relationships
- Locate specific code patterns
- Map out dependencies

Works by:
1. Tries Jedi (if installed) for accurate code analysis
2. Falls back to intelligent file search

For best results: pip install jedi`,
  inputSchema: exploreCodePythonSchema,
  defaultConsent: "always",

  getConsentPreview: (args) =>
    `Explore Python code for "${args.query}"${args.intent ? ` (${args.intent})` : ""}`,

  buildXml: (args, isComplete) => {
    if (!args.query) return undefined;
    let xml = `<dyad-explore-python query="${escapeXmlAttr(args.query)}"`;
    if (args.intent) xml += ` intent="${escapeXmlAttr(args.intent)}"`;
    if (args.file_path) xml += ` file="${escapeXmlAttr(args.file_path)}"`;
    xml += ">";
    if (isComplete) {
      xml += "</dyad-explore-python>";
    }
    return xml;
  },

  execute: async (args, ctx: AgentContext) => {
    const pythonCmd = await findPython();
    const scriptPath = path.join(ctx.appPath, "__dyad_explore.py");

    logger.log(`Exploring Python code for: ${args.query}`);

    ctx.onXmlStream(
      `<dyad-status title="${escapeXmlAttr(`Exploring Python code: ${args.query}`)}"></dyad-status>`,
    );

    try {
      // Write explorer script
      await fs.writeFile(scriptPath, EXPLORER_SCRIPT, "utf8");

      const command = `${pythonCmd} "${scriptPath}" "${ctx.appPath}" "${args.query.replace(/"/g, '\\"')}"`;

      const result = await new Promise<string>((resolve) => {
        exec(
          command,
          {
            cwd: ctx.appPath,
            timeout: 30000,
            maxBuffer: 1024 * 1024 * 5,
            encoding: "utf8",
            windowsHide: true,
          },
          async (error, stdout, stderr) => {
            let output = stdout || stderr || "";
            if (error && !output) {
              output = error.message;
            }

            try {
              const parsed = JSON.parse(output);
              let report = `## Python Code Exploration\n\n`;
              report += `**Query:** ${args.query}\n`;
              report += `**Type:** ${parsed.type}\n`;

              if (parsed.type === "definition") {
                report += `\n### Definitions Found\n\n`;
                for (const r of parsed.results) {
                  report += `- **${r.name}** (${r.type}) in \`${r.file}:${r.line}\`\n`;
                  if (r.description) report += `  ${r.description}\n`;
                }
              } else if (parsed.type === "completions") {
                report += `\n### Completions\n\n`;
                for (const r of parsed.results) {
                  report += `- **${r.name}** (${r.type})\n`;
                }
              } else {
                report += `**Files scanned:** ${parsed.files_scanned}\n`;
                report += `**Matches:** ${parsed.matches}\n\n`;

                if (parsed.results && parsed.results.length > 0) {
                  report += `### Matches\n\n`;
                  for (const r of parsed.results) {
                    const relPath = path.relative(ctx.appPath, r.file);
                    report += `- \`${relPath}:${r.line}\` \`${r.content}\`\n`;
                  }
                }
              }

              output = truncateOutput(report, MAX_OUTPUT_LENGTH);
            } catch {
              output = truncateOutput(output, MAX_OUTPUT_LENGTH);
            }

            resolve(output);
          },
        );
      });

      ctx.onXmlComplete(
        `<dyad-explore-python query="${escapeXmlAttr(args.query)}">\n${escapeXmlContent(result)}\n</dyad-explore-python>`,
      );

      return result;
    } catch (error: any) {
      const msg = `Exploration failed: ${error.message}`;
      ctx.onXmlComplete(
        `<dyad-explore-python query="${escapeXmlAttr(args.query)}">\n${escapeXmlContent(msg)}\n</dyad-explore-python>`,
      );
      return msg;
    } finally {
      // Clean up explorer script
      try {
        await fs.unlink(scriptPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  },
};
