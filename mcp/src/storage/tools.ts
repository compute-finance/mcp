// Tool classification shared by session + turn parsers. Currently Claude Code-
// flavored; adapters for other hosts should extend, not fork.
export const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
export const READ_TOOLS = new Set(["Read", "Grep", "Glob", "WebFetch"]);

// Map a cwd to the Claude Code projects/ subdir name. Handles POSIX and Windows
// separators (/, \, drive-letter colons) so lookup and scanning agree on the
// same encoded directory name regardless of host. Leading/trailing separators
// are trimmed — a cwd like `/foo/` and `/foo` must resolve to the same dir.
export function encodeCwd(cwd: string): string {
  const trimmed = cwd.replace(/^[\\/]+/, "").replace(/[\\/]+$/, "");
  return "-" + trimmed.replace(/[\\/:]/g, "-");
}

// Claude Code session IDs are UUID-shaped. Reject anything else — it's either
// malformed or a path-traversal attempt (`../..`).
const SESSION_ID_RE = /^[a-zA-Z0-9-]+$/;
export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id);
}

// A user-type record with a tool_result payload is a tool-use reply, NOT a
// human turn. Counting it inflates turn counts 2-5× on heavy tool sessions.
export function isHumanUserTurn(rec: any): boolean {
  if (rec?.type !== "user") return false;
  if (rec.toolUseResult !== undefined) return false;
  const content = rec.message?.content;
  if (Array.isArray(content)) {
    if (content.length === 0) return false;
    if (content.every((b: any) => b?.type === "tool_result")) return false;
  }
  return true;
}
