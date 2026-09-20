import { describe, it, expect } from "vitest";
import { isSelfCaptureTool } from "../src/hooks/self-capture.js";

describe("isSelfCaptureTool (#993)", () => {
  it("skips agentmemory MCP tools", () => {
    expect(isSelfCaptureTool("mcp__agentmemory__memory_save")).toBe(true);
    expect(isSelfCaptureTool("mcp__agentmemory__memory_recall")).toBe(true);
  });

  it("skips bare memory_* and agentmemory_* tools", () => {
    expect(isSelfCaptureTool("memory_smart_search")).toBe(true);
    expect(isSelfCaptureTool("agentmemory_status")).toBe(true);
  });

  it("is case-insensitive and trims", () => {
    expect(isSelfCaptureTool("  MCP__AgentMemory__memory_save ")).toBe(true);
  });

  it("keeps unrelated tools", () => {
    expect(isSelfCaptureTool("Bash")).toBe(false);
    expect(isSelfCaptureTool("Edit")).toBe(false);
    expect(isSelfCaptureTool("mcp__other__memory_save")).toBe(false);
  });

  it("keeps non-string / empty tool names", () => {
    expect(isSelfCaptureTool(undefined)).toBe(false);
    expect(isSelfCaptureTool(null)).toBe(false);
    expect(isSelfCaptureTool("")).toBe(false);
    expect(isSelfCaptureTool(42)).toBe(false);
  });
});
