import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import openclawPlugin from "../integrations/openclaw/plugin.mjs";

type OpenClawHandler = (event: Record<string, unknown>) => Promise<unknown>;

function mockFetch(calls: Array<{ url: string; body: any }>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(input), body });
    return new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function registerPlugin() {
  const handlers = new Map<string, OpenClawHandler>();
  openclawPlugin.register({
    pluginConfig: { base_url: "http://localhost:3111" },
    logger: { warn: vi.fn() },
    on(event: string, handler: OpenClawHandler) {
      handlers.set(event, handler);
    },
  });
  return handlers;
}

describe("OpenClaw plugin project scoping", () => {
  const originalFetch = globalThis.fetch;
  const originalAgentMemorySecret = process.env["AGENTMEMORY_SECRET"];

  beforeEach(() => {
    delete process.env["AGENTMEMORY_SECRET"];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalAgentMemorySecret === undefined) {
      delete process.env["AGENTMEMORY_SECRET"];
    } else {
      process.env["AGENTMEMORY_SECRET"] = originalAgentMemorySecret;
    }
  });

  it("passes event project into smart-search when available", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    mockFetch(calls);
    const handlers = registerPlugin();

    await handlers.get("before_prompt_build")?.({
      prompt: "recall auth changes",
      project: "team-alpha",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/agentmemory/smart-search");
    expect(calls[0].body).toMatchObject({
      query: "recall auth changes",
      limit: 5,
      project: "team-alpha",
    });
  });

  it("passes project and cwd into observe payload, falling back to session id when missing", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    mockFetch(calls);
    const handlers = registerPlugin();

    await handlers.get("agent_end")?.({
      success: true,
      sessionKey: "sess-123",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ],
    });

    // observe + session/end: the plugin closes the session it opened so
    // OpenClaw turns do not leave zombie `active` rows (#1058).
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain("/agentmemory/observe");
    expect(calls[0].body).toMatchObject({
      hookType: "post_tool_use",
      sessionId: "sess-123",
      project: "sess-123",
      cwd: "sess-123",
    });
    expect(calls[1].url).toContain("/agentmemory/session/end");
    expect(calls[1].body).toMatchObject({ sessionId: "sess-123" });
  });

  it("threads agentId from the hook context into recall and capture", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    mockFetch(calls);
    const handlers = registerPlugin();

    await handlers.get("before_prompt_build")?.(
      { prompt: "scoped recall" },
      { agentId: "agent-7" },
    );
    await handlers.get("agent_end")?.(
      {
        success: true,
        sessionKey: "sess-agent",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "there" },
        ],
      },
      { agentId: "agent-7" },
    );

    expect(calls[0].body).toMatchObject({ agentId: "agent-7" });
    expect(calls[1].body).toMatchObject({ agentId: "agent-7" });
  });

  it("normalizes a raw cwd path to its git basename (#1058)", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    mockFetch(calls);
    const handlers = registerPlugin();

    await handlers.get("before_prompt_build")?.({
      prompt: "recall",
      cwd: "/home/dev/repos/agentmemory",
    });

    expect(calls[0].body).toMatchObject({ project: "agentmemory" });
  });

  it("uses nested workspace project metadata when top-level project is absent", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    mockFetch(calls);
    const handlers = registerPlugin();

    await handlers.get("before_prompt_build")?.({
      prompt: "open memory",
      workspace: { project: "nested-proj" },
    });

    expect(calls[0].body).toMatchObject({ project: "nested-proj" });
  });
});
