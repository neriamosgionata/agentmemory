import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// A large mem-live sync backlog processed in one synchronous forEach froze
// Chrome. The viewer now processes it in bounded chunks. #609
describe("viewer sync backlog chunking (#609)", () => {
  const viewer = readFileSync("src/viewer/index.html", "utf-8");

  it("routes sync events through processSyncBacklog", () => {
    expect(viewer).toMatch(/evt\.type === 'sync'\)\s*\{\s*processSyncBacklog\(/);
  });

  it("bounds each chunk and yields between them", () => {
    expect(viewer).toMatch(/var SYNC_CHUNK_SIZE = 200;/);
    expect(viewer).toMatch(/setTimeout\(step, 0\)/);
  });
});

// Actions with legacy string tags crashed renderActions before it replaced
// the placeholder, leaving the tab on "Loading actions...". #906
describe("viewer action tag normalization (#906)", () => {
  const viewer = readFileSync("src/viewer/index.html", "utf-8");

  it("never joins raw a.tags", () => {
    expect(viewer).not.toMatch(/\(a\.tags \|\| \[\]\)\.join/);
    expect(viewer).not.toMatch(/\(a\.tags \|\| \[\]\)\.map/);
  });

  it("renders tags through actionTags", () => {
    expect(viewer).toMatch(/actionTags\(a\)\.join/);
    expect(viewer).toMatch(/actionTags\(a\)\.map/);
  });
});
