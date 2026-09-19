#!/usr/bin/env node
import { resolveProject, hookCwd } from "./_project.js";

function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

// Pre-tool-use enrichment hook.
//
// THIS HOOK IS A NO-OP BY DEFAULT AS OF 0.8.10 (#143). Previously it
// fired /agentmemory/enrich on every Edit/Write/Read/Glob/Grep tool call
// and wrote up to 4000 chars of context to stdout. Claude Code reads
// PreToolUse stdout and prepends it to the model's next turn, which meant
// agentmemory was silently injecting ~1000 tokens into every tool turn
// via the user's Claude Code session. On Claude Pro that burned entire
// allocations in a handful of messages (@adrianricardo, #143).
//
// Users who explicitly want pre-tool enrichment opt in with:
//   AGENTMEMORY_INJECT_CONTEXT=true   in ~/.agentmemory/.env
// and restart Claude Code. Expect your session input token count to grow
// proportionally with the number of file-touching tool calls per turn.
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";

// #1278: enrich measured 1.9-4.3s on real stores, so the old 2s abort
// guaranteed the hook gave up before the context arrived. 8s is the default
// and the op-in nature of the hook (AGENTMEMORY_INJECT_CONTEXT) makes the
// wait acceptable; override with AGENTMEMORY_INJECT_TIMEOUT_MS.
const INJECT_TIMEOUT_MS = (() => {
  const raw = parseInt(process.env["AGENTMEMORY_INJECT_TIMEOUT_MS"] || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 8000;
})();

// Claude Code consumes hookSpecificOutput.additionalContext; raw stdout is
// documented as plain text but several hosts drop it (the #1278 report).
// Cursor reads additional_context, and Copilot's camelCase payload is
// consumed as plain stdout, so keep raw for shapes that aren't Claude/Devin.
function contextEnvelope(
  data: Record<string, unknown>,
  context: string,
): string {
  if (typeof data.cursor_version === "string") {
    return JSON.stringify({ additional_context: context });
  }
  const isClaudeShape = typeof data.tool_name === "string";
  const isDevin =
    process.env["DEVIN_PROJECT_DIR"] !== undefined ||
    data.prompt_id !== undefined;
  if (isClaudeShape || isDevin) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: context,
      },
    });
  }
  return context;
}

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
}

async function main() {
  // Default off: exit immediately so we don't even open stdin. This keeps
  // Claude Code's tool-call hot path as cheap as possible.
  if (!INJECT_CONTEXT) return;

  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    return;
  }

  if (!data || typeof data !== "object") return;
  if (isSdkChildContext(data)) return;

  const toolName =
    typeof data.tool_name === "string"
      ? data.tool_name
      : typeof data.toolName === "string"
        ? data.toolName
        : undefined;
  if (!toolName) return;

  const normalizedToolName = toolName.toLowerCase();
  const fileTools = ["edit", "write", "create", "read", "view", "glob", "grep"];
  if (!fileTools.includes(normalizedToolName)) return;

  const rawToolInput = data.tool_input ?? data.toolArgs;
  const toolInput =
    typeof rawToolInput === "object" &&
    rawToolInput !== null &&
    !Array.isArray(rawToolInput)
      ? (rawToolInput as Record<string, unknown>)
      : {};
  const files: string[] = [];
  const fileKeys =
    normalizedToolName === "grep"
      ? ["path", "file"]
      : ["file_path", "path", "file", "pattern"];
  for (const key of fileKeys) {
    const val = toolInput[key];
    if (typeof val === "string" && val.length > 0) files.push(val);
  }
  if (files.length === 0) return;

  const terms: string[] = [];
  if (normalizedToolName === "grep" || normalizedToolName === "glob") {
    const pattern = toolInput["pattern"];
    if (typeof pattern === "string" && pattern.length > 0) {
      terms.push(pattern);
    }
  }

  const rawSessionId = data.session_id || data.sessionId || data.conversation_id;
  const sessionId =
    typeof rawSessionId === "string" && rawSessionId.length > 0
      ? rawSessionId
      : "unknown";
  // #1278: payload-only project lookup left env-scoped hosts (Claude Code
  // sets AGENTMEMORY_PROJECT_NAME) sending unscoped enrich calls.
  const project =
    typeof data.project === "string" && data.project.trim().length > 0
      ? data.project.trim()
      : resolveProject(hookCwd(data) || process.cwd());

  try {
    const res = await fetch(`${REST_URL}/agentmemory/enrich`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        sessionId,
        files,
        terms,
        toolName,
        ...(project !== undefined && { project }),
      }),
      signal: AbortSignal.timeout(INJECT_TIMEOUT_MS),
    });

    if (res.ok) {
      const result = (await res.json()) as { context?: string };
      if (result.context) {
        process.stdout.write(contextEnvelope(data, result.context));
      }
    }
  } catch {
    // don't block tool execution
  }
}

main().catch(() => process.exit(0));
