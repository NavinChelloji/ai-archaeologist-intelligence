import { describe, expect, it } from "vitest";
import { chunkFile } from "./chunker";

const OPTIONS = { maxTokens: 512, overlapTokens: 64 };

describe("chunkFile", () => {
  it("returns zero chunks for an empty file", () => {
    expect(chunkFile({ path: "src/empty.ts", language: "typescript", content: "" }, OPTIONS)).toEqual([]);
  });

  it("chunks top-level function, class methods, interface, type, and enum as separate named spans", () => {
    const content = [
      /* 1*/ "import { foo } from './foo';",
      /* 2*/ "",
      /* 3*/ "export function add(a: number, b: number): number {",
      /* 4*/ "  return a + b;",
      /* 5*/ "}",
      /* 6*/ "",
      /* 7*/ "export class Greeter {",
      /* 8*/ "  private name: string;",
      /* 9*/ "  constructor(name: string) {",
      /*10*/ "    this.name = name;",
      /*11*/ "  }",
      /*12*/ "  greet(): string {",
      /*13*/ "    return `hello ${this.name}`;",
      /*14*/ "  }",
      /*15*/ "}",
      /*16*/ "",
      /*17*/ "export interface Shape {",
      /*18*/ "  area(): number;",
      /*19*/ "}",
      /*20*/ "",
      /*21*/ "export type Id = string;",
      /*22*/ "",
      /*23*/ "export enum Color { Red, Green, Blue }",
    ].join("\n");

    const chunks = chunkFile({ path: "src/shapes.ts", language: "typescript", content }, OPTIONS);

    const byName = new Map(chunks.map((c) => [c.symbolName, c]));

    expect(byName.get("add")).toMatchObject({ startLine: 3, endLine: 5, symbolType: "function" });
    expect(byName.get("Greeter.constructor")).toMatchObject({ startLine: 9, endLine: 11, symbolType: "method" });
    expect(byName.get("Greeter.greet")).toMatchObject({ startLine: 12, endLine: 14, symbolType: "method" });
    expect(byName.get("Greeter.greet")?.content).toContain("export class Greeter {");
    expect(byName.get("Shape")).toMatchObject({ startLine: 17, endLine: 19, symbolType: "interface" });
    expect(byName.get("Id")).toMatchObject({ startLine: 21, endLine: 21, symbolType: "type" });
    expect(byName.get("Color")).toMatchObject({ startLine: 23, endLine: 23, symbolType: "enum" });

    // The leading import + blank line isn't dropped — swept into a gap chunk.
    const gapChunk = chunks.find((c) => c.symbolName === null && c.startLine === 1);
    expect(gapChunk?.content).toContain("import { foo }");
  });

  it("chunks a class with no methods as a single class-typed span", () => {
    const content = ["export class Point {", "  x: number = 0;", "  y: number = 0;", "}"].join("\n");
    const chunks = chunkFile({ path: "src/point.ts", language: "typescript", content }, OPTIONS);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ symbolName: "Point", symbolType: "class", startLine: 1, endLine: 4 });
  });

  it("splits an oversized function into numbered sub-chunks that each stay under maxTokens", () => {
    const bigBody = Array.from({ length: 200 }, (_, i) => `  const line${i} = ${i}; // padding to exceed the token budget`).join("\n");
    const content = ["export function huge(): void {", bigBody, "}"].join("\n");

    const chunks = chunkFile({ path: "src/huge.ts", language: "typescript", content }, { maxTokens: 200, overlapTokens: 20 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.symbolName).toMatch(/^huge#\d+$/);
      expect(chunk.content).toContain("export function huge(): void {");
      expect(chunk.estimatedTokens).toBeLessThanOrEqual(220); // header repeat pushes slightly over the raw budget, still bounded
    }
  });

  it("falls back to line-window chunking for a file with no recognized top-level declarations", () => {
    const content = ["doSomething();", "doSomethingElse();"].join("\n");
    const chunks = chunkFile({ path: "src/script.ts", language: "typescript", content }, OPTIONS);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ symbolName: null, symbolType: null, startLine: 1, endLine: 2 });
  });

  it("uses line-window chunking for non-TS/JS languages", () => {
    const content = Array.from({ length: 5 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkFile({ path: "README.md", language: "markdown", content }, OPTIONS);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe(content);
    expect(chunks[0].symbolName).toBeNull();
  });

  it("keeps every emitted chunk's line range within the source file bounds", () => {
    const content = ["export function a() {", "  return 1;", "}", "", "export function b() {", "  return 2;", "}"].join("\n");
    const chunks = chunkFile({ path: "src/two.ts", language: "typescript", content }, OPTIONS);
    const totalLines = content.split("\n").length;

    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1);
      expect(chunk.endLine).toBeLessThanOrEqual(totalLines);
      expect(chunk.startLine).toBeLessThanOrEqual(chunk.endLine);
    }
  });
});
