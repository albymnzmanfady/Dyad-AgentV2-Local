import { z } from "zod";

import { readSettings } from "@/main/settings";
import {
  formatCodeExplorerDisabledReason,
  getCodeExplorerAvailability,
} from "@/ipc/processors/code_explorer";
import {
  AgentContext,
  ToolDefinition,
  escapeXmlAttr,
  escapeXmlContent,
} from "./types";
import type { CodeExplorerResult } from "../../../../../../../shared/code_explorer_types";
import {
  exploreCodeSchema,
  formatRawExploreCodeResult,
  normalizeExploreCodeArgsForApp,
  runRawExploreCode,
} from "./explore_code_raw";
import { runExploreCodeSubagent } from "./explore_code_subagent";
import { resolveTargetAppPath } from "./resolve_app_context";

export function getExploreCodeAvailability(ctx: AgentContext): {
  enabled: boolean;
  reason: string | null;
  tsconfigPath: string | null;
} {
  return getExploreCodeAvailabilityForAppPath(ctx, ctx.appPath);
}

function getExploreCodeAvailabilityForAppPath(
  ctx: AgentContext,
  appPath: string,
): {
  enabled: boolean;
  reason: string | null;
  tsconfigPath: string | null;
} {
  if (ctx.freeLocalAgentMode) {
    const availability = getCodeExplorerAvailability(appPath);
    return {
      enabled: availability.ready,
      reason: availability.ready
        ? null
        : (availability.reason ?? formatCodeExplorerDisabledReason(availability)),
      tsconfigPath: availability.tsconfigPath,
    };
  }

  if (!ctx.isDyadPro) {
    return {
      enabled: false,
      reason: "dyad_pro_required",
      tsconfigPath: null,
    };
  }

  const settings = readSettings();
  if (!settings.enableCodeExplorer) {
    return {
      enabled: false,
      reason: "code_explorer_setting_disabled",
      tsconfigPath: null,
    };
  }

  const availability = getCodeExplorerAvailability(appPath);
  return {
    enabled: availability.ready,
    reason: availability.ready
      ? null
      : (availability.reason ?? formatCodeExplorerDisabledReason(availability)),
    tsconfigPath: availability.tsconfigPath,
  };
}

function buildExploreCodeAttributes(
  args: Partial<z.infer<typeof exploreCodeSchema>>,
  result?: CodeExplorerResult,
): string {
  const attrs: string[] = [];
  if (args.query) attrs.push(`query="${escapeXmlAttr(args.query)}"`);
  if (args.intent) attrs.push(`intent="${escapeXmlAttr(args.intent)}"`);
  if (args.app_name) attrs.push(`app_name="${escapeXmlAttr(args.app_name)}"`);
  if (args.tsconfig_path) {
    attrs.push(`tsconfig_path="${escapeXmlAttr(args.tsconfig_path)}"`);
  }
  if (result) {
    attrs.push(`files="${result.files.length}"`);
    attrs.push(`symbols="${result.totalSymbols}"`);
    attrs.push(`index_ms="${result.indexMs}"`);
    attrs.push(`search_ms="${result.searchMs}"`);
    if (result.truncated) attrs.push(`truncated="true"`);
  }
  return attrs.join(" ");
}

export const exploreCodeTool: ToolDefinition<
  z.infer<typeof exploreCodeSchema>
> = {
  name: "explore_code",
  description: `Find and map relevant code for a query using TypeScript's language service for symbol analysis and code exploration.

Set the intent argument to what you will do with the result: explain to understand behavior; locate to find the best files or symbols; edit or debug when preparing to change, diagnose, or verify code.

The tool returns a structured report with matching files, symbols, and code ranges. Use it to:
- Understand code structure and relationships
- Find where specific functions/classes/types are defined
- Map out data flow and dependencies
- Prepare for edits by understanding the surrounding code

If TypeScript is not installed in the app, falls back to grep-based keyword search.`,
  inputSchema: exploreCodeSchema,
  defaultConsent: "always",
  usesEngineEndpoint: true,

  isEnabled: (ctx) => getExploreCodeAvailability(ctx).enabled,

  getConsentPreview: (args) => {
    let preview = `Explore code for "${args.query}"`;
    if (args.app_name) preview += ` (app: ${args.app_name})`;
    return preview;
  },

  buildXml: (args, isComplete) => {
    if (!args.query) return undefined;
    if (isComplete) return undefined;
    return `<dyad-explore-code ${buildExploreCodeAttributes(args)}>Exploring...`;
  },

  execute: async (args, ctx: AgentContext) => {
    const targetAppPath = resolveTargetAppPath(ctx, args.app_name);
    const availability = getExploreCodeAvailabilityForAppPath(
      ctx,
      targetAppPath,
    );

    if (!availability.enabled) {
      const reason =
        availability.reason ?? "TypeScript code explorer unavailable";
      ctx.onXmlComplete(
        `<dyad-explore-code ${buildExploreCodeAttributes(args)}>\n${escapeXmlContent(`Code explorer unavailable: ${reason}. Try grep or list_files for manual exploration.`)}\n</dyad-explore-code>`,
      );
      return `Code explorer unavailable: ${reason}. Use grep or list_files for manual exploration.`;
    }

    const effectiveArgs = normalizeExploreCodeArgsForApp({
      appPath: targetAppPath,
      args,
      fallbackTsconfigPath: availability.tsconfigPath,
    });

    if (ctx.freeLocalAgentMode) {
      try {
        const result = await runRawExploreCode({
          appPath: targetAppPath,
          args: effectiveArgs,
        });

        const report = formatRawExploreCodeResult(result);

        ctx.onXmlComplete(
          `<dyad-explore-code ${buildExploreCodeAttributes(effectiveArgs, result)}>\n${escapeXmlContent(report)}\n</dyad-explore-code>`,
        );
        return report;
      } catch (error) {
        const errorMsg =
          error instanceof Error ? error.message : String(error);
        ctx.onXmlComplete(
          `<dyad-explore-code ${buildExploreCodeAttributes(effectiveArgs)}>\n${escapeXmlContent(`Code exploration failed: ${errorMsg}`)}\n</dyad-explore-code>`,
        );
        return `Code exploration failed: ${errorMsg}. Use grep or list_files for manual exploration.`;
      }
    }

    const streamExploreProgress = (progressText: string) => {
      ctx.onXmlStream(
        `<dyad-explore-code ${buildExploreCodeAttributes(effectiveArgs)}>\n${escapeXmlContent(progressText)}`,
      );
    };

    streamExploreProgress("Exploring...");

    const resultText = await runExploreCodeSubagent({
      args: effectiveArgs,
      ctx,
      onProgress: streamExploreProgress,
    });
    ctx.onXmlComplete(
      `<dyad-explore-code ${buildExploreCodeAttributes(effectiveArgs)}>\n${escapeXmlContent(resultText)}\n</dyad-explore-code>`,
    );
    return resultText;
  },
};
