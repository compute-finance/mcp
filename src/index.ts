#!/usr/bin/env node

if (process.argv[2] === "setup") {
  await import("./setup.js");
  process.exit(0);
}
if (process.argv[2] === "hook-prompt") {
  await import("./hooks/prompt-cost-inject.js");
  process.exit(0);
}

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  getBasketPrices,
  getModelPrice,
  getScu,
  getBreakdown,
  getCpi,
  getReconstitutions,
  getMethodology,
  getActiveMethodologyVersion,
  getHistory as getOracleHistory,
  getModelPriceHistory,
  getCatalog,
  getModelPriceAt,
  getBaseline,
  getScuAt,
  costUsd,
} from "./oracle/client.js";
import {
  getAllOracleToolSchemas,
  getAllOracleToolResponseSchemas,
  isOracleBackedTool,
  warmOpenApiCache,
} from "./oracle/openapi-schema.js";
import { initFieldMap, getFieldMap } from "./oracle/field-map.js";
import { renderSessionReport } from "./render/session_report.js";
import { renderConsumptionReport } from "./render/consumption_report.js";
import { renderActiveSessions } from "./render/sessions_list.js";
import { round } from "./render/format.js";
import { toolDefinitions, ToolDef } from "./tools/definitions.js";
import {
  requireString,
  requireFiniteNumber,
  checkOptionalSessionId,
  optionalString,
  optionalBoolean,
  optionalPositiveNumber,
  optionalHistoryGranularity,
} from "./tools/validation.js";
import { text, errorText, textWithContext, isErrorResult } from "./tools/response.js";
import { rawAnalyzeSession, rawAnalyzeInferences, getHistory } from "./tools/analyze.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf-8"),
) as { version: string };

const server = new Server(
  { name: "@compute-finance/mcp", version: pkg.version },
  { capabilities: { tools: {} } },
);

async function buildTools(): Promise<ToolDef[]> {
  const oracleSchemas = await getAllOracleToolSchemas();
  const responseSchemas = await getAllOracleToolResponseSchemas();

  return toolDefinitions.map((tool) => {
    let updated = tool;
    if (isOracleBackedTool(tool.name) && oracleSchemas[tool.name]) {
      updated = { ...updated, inputSchema: oracleSchemas[tool.name] };
    }
    if (responseSchemas[tool.name]) {
      updated = {
        ...updated,
        description:
          updated.description +
          "\n\nOracle response schema (auto-derived from OpenAPI at startup):\n" +
          JSON.stringify(responseSchemas[tool.name]),
      };
    }
    return updated;
  });
}

type HistoryQueryArgs = {
  from?: string;
  to?: string;
  granularity?: "per-revision" | "daily" | "weekly";
  limit?: number;
};

function parseHistoryQueryArgs(a: Record<string, unknown>): HistoryQueryArgs | { error: string } {
  const from = optionalString(a.from, "from");
  if (typeof from === "object" && from !== null) return from;
  const to = optionalString(a.to, "to");
  if (typeof to === "object" && to !== null) return to;
  const granularity = optionalHistoryGranularity(a.granularity, "granularity");
  if (typeof granularity === "object" && granularity !== null) return granularity;
  const limit = optionalPositiveNumber(a.limit, "limit");
  if (typeof limit === "object" && limit !== null) return limit;
  return { from, to, granularity, limit };
}

const startupPromise = warmOpenApiCache().then(() =>
  Promise.all([buildTools(), initFieldMap()]),
);
const toolsPromise: Promise<ToolDef[]> = startupPromise.then(([tools]) => tools);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: await toolsPromise,
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  await startupPromise;
  const { name, arguments: args } = req.params;
  const a = (args ?? {}) as Record<string, unknown>;

  try {
    switch (name) {
      case "data_get_basket": {
        return textWithContext({
          models: await getBasketPrices(),
          source: "api.compute.finance/v1/oracle/basket",
        });
      }
      case "data_get_price": {
        const model = requireString(a.model, "model");
        if (typeof model !== "string") return errorText(model.error);
        const price = await getModelPrice(model);
        if (!price) return errorText(`Model not in basket: ${model}`);
        return textWithContext(price);
      }
      case "data_get_scu":
        return textWithContext(await getScu());
      case "data_get_breakdown":
        return textWithContext(await getBreakdown());
      case "data_get_cpi":
        return textWithContext(await getCpi());
      case "data_get_methodology":
        return textWithContext(await getMethodology());
      case "data_get_reconstitutions": {
        const limit = optionalPositiveNumber(a.limit, "limit");
        if (typeof limit === "object" && limit !== null) return errorText(limit.error);
        const fm = getFieldMap().recon;
        const data = await getReconstitutions() as Record<string, unknown>;
        const entries = (data[fm.entries_array] ?? []) as Record<string, unknown>[];
        const sorted = [...entries].sort(
          (a, b) =>
            new Date(b[fm.sort_date] as string).getTime() -
            new Date(a[fm.sort_date] as string).getTime(),
        );
        return textWithContext(
          typeof limit === "number"
            ? { [fm.entries_array]: sorted.slice(0, limit) }
            : { [fm.entries_array]: sorted },
        );
      }
      case "data_get_history": {
        const query = parseHistoryQueryArgs(a);
        if ("error" in query) return errorText(query.error);
        return textWithContext(await getOracleHistory(query));
      }
      case "data_get_model_price_history": {
        const model = requireString(a.model, "model");
        if (typeof model !== "string") return errorText(model.error);
        const query = parseHistoryQueryArgs(a);
        if ("error" in query) return errorText(query.error);
        return textWithContext(await getModelPriceHistory(model, query));
      }
      case "data_get_catalog": {
        return textWithContext(await getCatalog());
      }
      case "data_get_model_price_at": {
        const model = requireString(a.model, "model");
        if (typeof model !== "string") return errorText(model.error);
        const date = requireString(a.date, "date");
        if (typeof date !== "string") return errorText(date.error);
        return textWithContext(await getModelPriceAt(model, date));
      }
      case "data_get_baseline":
        return textWithContext(await getBaseline());

      case "data_get_scu_at": {
        const date = requireString(a.date, "date");
        if (typeof date !== "string") return errorText(date.error);
        return textWithContext(await getScuAt(date));
      }

      case "compute_estimate": {
        const model = requireString(a.model, "model");
        if (typeof model !== "string") return errorText(model.error);
        const inT = requireFiniteNumber(a.input_tokens, "input_tokens");
        if (typeof inT !== "number") return errorText(inT.error);
        const outT = requireFiniteNumber(a.output_tokens, "output_tokens");
        if (typeof outT !== "number") return errorText(outT.error);
        const price = await getModelPrice(model);
        if (!price) return errorText(`Model not in basket: ${model}`);
        return textWithContext({
          model: price.model,
          input_tokens: inT,
          output_tokens: outT,
          usd_cost: round(costUsd(price, inT, outT), 6),
          source: "api.compute.finance/v1/oracle/basket",
        });
      }
      case "compute_compare": {
        const inT = requireFiniteNumber(a.input_tokens, "input_tokens");
        if (typeof inT !== "number") return errorText(inT.error);
        const outT = requireFiniteNumber(a.output_tokens, "output_tokens");
        if (typeof outT !== "number") return errorText(outT.error);
        const [basket, methodologyVersion] = await Promise.all([
          getBasketPrices(),
          getActiveMethodologyVersion(),
        ]);
        const ranked = basket
          .map((p) => ({
            model: p.model,
            provider: p.provider,
            family: p.family,
            usd_cost: round(costUsd(p, inT, outT), 6),
          }))
          .sort((x, y) => x.usd_cost - y.usd_cost);
        const by_family: Record<string, typeof ranked> = {};
        for (const row of ranked) {
          const key = row.family || "(unspecified)";
          (by_family[key] ??= []).push(row);
        }
        return textWithContext({
          input_tokens: inT,
          output_tokens: outT,
          ranked,
          by_family,
          methodology_version: methodologyVersion,
          source: "api.compute.finance/v1/oracle/basket",
        });
      }

      case "render_session_report": {
        const sid = checkOptionalSessionId(a.session_id);
        if (sid && typeof sid === "object") return errorText(sid.error);
        const cwd = optionalString(a.cwd, "cwd");
        if (typeof cwd === "object" && cwd !== null) return errorText(cwd.error);
        return text({ text: await renderSessionReport({ session_id: sid, cwd }) });
      }
      case "render_consumption_report": {
        const sid = checkOptionalSessionId(a.session_id);
        if (sid && typeof sid === "object") return errorText(sid.error);
        const cwd = optionalString(a.cwd, "cwd");
        if (typeof cwd === "object" && cwd !== null) return errorText(cwd.error);
        const full = optionalBoolean(a.full, "full");
        if (typeof full === "object" && full !== null) return errorText(full.error);
        return text({ text: await renderConsumptionReport({ session_id: sid, cwd, full }) });
      }
      case "render_active_sessions": {
        const cwd = optionalString(a.cwd, "cwd");
        if (typeof cwd === "object" && cwd !== null) return errorText(cwd.error);
        const limit = optionalPositiveNumber(a.limit, "limit");
        if (typeof limit === "object" && limit !== null) return errorText(limit.error);
        const hours = optionalPositiveNumber(a.hours, "hours");
        if (typeof hours === "object" && hours !== null) return errorText(hours.error);
        return text({
          text: await renderActiveSessions({
            cwd,
            limit: limit as number | undefined,
            hours: hours as number | undefined,
          }),
        });
      }

      case "analyze_session": {
        const result = await rawAnalyzeSession(a);
        if (isErrorResult(result)) return errorText(result.error);
        return text(result);
      }
      case "analyze_inferences": {
        const result = await rawAnalyzeInferences(a);
        if (isErrorResult(result)) return errorText(result.error);
        return text(result);
      }
      case "telemetry_get_history":
        return text(await getHistory());

      default:
        return errorText(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return errorText((err as Error).message);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
