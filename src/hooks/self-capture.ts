// Tool hooks capture every PostToolUse/PostToolFailure event, including calls
// the host agent makes to agentmemory's own MCP tools. Those observations then
// surface in later recalls as memory about memory (pollution). Skip our own
// tool names; keep everything else. #993
const SELF_TOOL_PREFIXES = [
  "mcp__agentmemory",
  "agentmemory_",
  "memory_",
];

export function isSelfCaptureTool(toolName: unknown): boolean {
  if (typeof toolName !== "string") return false;
  const name = toolName.trim().toLowerCase();
  if (!name) return false;
  return SELF_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}
