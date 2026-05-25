import { getSessionContext } from "./context.js";

export function text(obj: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

export function errorText(msg: string) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: msg }, null, 2) }],
    isError: true,
  };
}

export async function textWithContext(obj: unknown) {
  const ctx = await getSessionContext();
  if (!ctx || typeof obj !== "object" || obj === null) return text(obj);
  return text({ ...obj, _session_context: ctx });
}

export function isErrorResult(v: unknown): v is { error: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    "error" in v &&
    typeof (v as Record<string, unknown>).error === "string"
  );
}
