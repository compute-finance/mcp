import { getAllOracleToolResponseSchemas } from "../oracle/openapi-schema.js";
import { toolDefinitions, ToolDef } from "./definitions.js";

export async function buildTools(): Promise<ToolDef[]> {
  const responseSchemas = await getAllOracleToolResponseSchemas();

  return toolDefinitions.map((tool) => {
    const responseSchema = tool.adaptedOutput ? undefined : responseSchemas[tool.name];
    if (!responseSchema) return tool;
    return {
      ...tool,
      description:
        tool.description +
        "\n\nOracle response schema (auto-derived from OpenAPI at startup):\n" +
        JSON.stringify(responseSchema),
    };
  });
}
