import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  endsWithJsonClose,
  findRepairBoundary,
  repairStateStore,
  scanStateStore,
} from "../src/state/store-repair.js";

describe("store-repair (#1364)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "am-store-repair-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("endsWithJsonClose", () => {
    it("accepts object and array closers, with trailing whitespace", () => {
      expect(endsWithJsonClose(Buffer.from('{"a":1}'))).toBe(true);
      expect(endsWithJsonClose(Buffer.from("[1,2]\n"))).toBe(true);
      expect(endsWithJsonClose(Buffer.from('{"a":1}   \r\n\t'))).toBe(true);
    });

    it("rejects non-JSON tails, including the 0x00/0x1D garbage from the report", () => {
      const corrupt = Buffer.concat([
        Buffer.from('{"a":1}}'),
        Buffer.from([0x00, 0x00, 0x96, 0x2f, 0x9f, 0x1d, 0x28, 0x34]),
      ]);
      expect(endsWithJsonClose(corrupt)).toBe(false);
      expect(endsWithJsonClose(Buffer.from("[1,2,3"))).toBe(false);
    });

    it("treats an empty file as non-suspicious", () => {
      expect(endsWithJsonClose(Buffer.alloc(0))).toBe(true);
    });
  });

  describe("findRepairBoundary", () => {
    it("returns null for valid JSON", () => {
      expect(findRepairBoundary('{"a":1}')).toBeNull();
      expect(findRepairBoundary("[1,2,3]")).toBeNull();
    });

    it("finds the last complete JSON value with garbage appended", () => {
      const content = '{"a":1,"b":{"c":2}}\u0000\u0096\u001d';
      const boundary = findRepairBoundary(content);
      expect(boundary).not.toBeNull();
      expect(content.slice(0, boundary!)).toBe('{"a":1,"b":{"c":2}}');
      expect(JSON.parse(content.slice(0, boundary!))).toEqual({
        a: 1,
        b: { c: 2 },
      });
    });

    it("returns null when no parseable prefix exists", () => {
      expect(findRepairBoundary("not json at all }{")).toBeNull();
      expect(findRepairBoundary("")).toBeNull();
    });

    it("does not repair valid JSON containing braces inside strings", () => {
      const content = '{"text":"a } brace","n":1}';
      expect(findRepairBoundary(content)).toBeNull();
    });
  });

  describe("scan + repair", () => {
    it("flags only corrupt files and leaves clean ones alone", () => {
      writeFileSync(join(dir, "mem%3Aclean.bin"), '{"a":1}');
      writeFileSync(
        join(dir, "mem%3Ainsights.bin"),
        Buffer.concat([
          Buffer.from('{"i1":{"a":1},"i2":{"a":2}}'),
          Buffer.from([0x00, 0x00, 0x1d]),
        ]),
      );
      writeFileSync(join(dir, "notes.txt"), "not scanned");

      const scan = scanStateStore(dir);
      expect(scan.scanned).toBe(2);
      expect(scan.suspicious).toEqual(["mem%3Ainsights.bin"]);
      expect(scan.errors).toEqual([]);
    });

    it("truncates garbage and preserves the JSON payload", () => {
      const good = '{"i1":{"a":1},"i2":{"a":2}}';
      const corrupt = Buffer.concat([
        Buffer.from(good),
        Buffer.from([0x00, 0x00, 0x96, 0x2f]),
      ]);
      writeFileSync(join(dir, "mem%3Ainsights.bin"), corrupt);

      const report = repairStateStore(dir);
      expect(report.repaired.length).toBe(1);
      expect(report.repaired[0]!.file).toBe("mem%3Ainsights.bin");
      expect(report.repaired[0]!.removedBytes).toBe(4);

      const after = readFileSync(join(dir, "mem%3Ainsights.bin"), "utf-8");
      expect(after).toBe(good);
      expect(JSON.parse(after)).toEqual({ i1: { a: 1 }, i2: { a: 2 } });
    });

    it("is a no-op when every file is clean", () => {
      writeFileSync(join(dir, "a.bin"), "[1]");
      writeFileSync(join(dir, "b.bin"), "{}");
      const report = repairStateStore(dir);
      expect(report.repaired).toEqual([]);
      expect(report.errors).toEqual([]);
      expect(readdirSync(dir).sort()).toEqual(["a.bin", "b.bin"]);
    });

    it("reports an error for a corrupt file with no parseable prefix", () => {
      writeFileSync(join(dir, "junk.bin"), "garbage \u0000 bytes");
      const report = repairStateStore(dir);
      expect(report.repaired).toEqual([]);
      expect(report.errors.length).toBe(1);
      expect(readFileSync(join(dir, "junk.bin"), "utf-8")).toBe(
        "garbage \u0000 bytes",
      );
    });

    it("reports a missing directory instead of throwing", () => {
      const scan = scanStateStore(join(dir, "nope"));
      expect(scan.scanned).toBe(0);
      expect(scan.suspicious).toEqual([]);
      expect(scan.errors.length).toBe(1);
    });
  });
});
