import ts from "typescript";
import type { SymbolType } from "@aca/contracts";
import { chunkByLineWindow } from "./line-window-chunker";
import { estimateTokens } from "./token-estimate";
import type { ChunkSpec } from "./chunk-types";

export interface TsChunkOptions {
  maxTokens: number;
  overlapTokens: number;
}

const SCRIPT_KIND_BY_EXTENSION: Record<string, ts.ScriptKind> = {
  ts: ts.ScriptKind.TS,
  tsx: ts.ScriptKind.TSX,
  js: ts.ScriptKind.JS,
  jsx: ts.ScriptKind.JSX,
  mjs: ts.ScriptKind.JS,
  cjs: ts.ScriptKind.JS,
};

export function isTsChunkable(path: string): boolean {
  return extensionOf(path) in SCRIPT_KIND_BY_EXTENSION;
}

function extensionOf(path: string): string {
  const idx = path.lastIndexOf(".");
  return idx === -1 ? "" : path.slice(idx + 1).toLowerCase();
}

interface RawSpan {
  startLine: number;
  endLine: number;
  symbolName: string | null;
  symbolType: SymbolType | null;
  /** Repeated on every sub-chunk if the span is later split — a class's own signature line, so a method chunk never loses "which class am I in" once split out of its class body. */
  contextPrefix: string | null;
}

/**
 * Symbol-aware chunking for TS/JS (SEARCH_EMBEDDING_SERVICE_PLAN.md
 * "Chunking Strategy" steps 1-3). Top-level declarations become chunks;
 * a class's methods are decomposed into individual chunks (one per method,
 * prefixed with the class signature) rather than one blob per class, per
 * the doc's explicit "class signature for methods" context-overlap
 * instruction. Oversized spans are re-split by `chunkByLineWindow` over
 * their own line range — a line-boundary split approximates "statement
 * boundaries" closely enough for realistically formatted code without a
 * second AST-walking implementation. Anything not captured by a named span
 * (imports, bare top-level statements, blank runs) is swept up afterward so
 * every line of the file is covered by some chunk.
 */
export function chunkTsFile(input: { path: string; content: string }, options: TsChunkOptions): ChunkSpec[] {
  const scriptKind = SCRIPT_KIND_BY_EXTENSION[extensionOf(input.path)] ?? ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(input.path, input.content, ts.ScriptTarget.Latest, true, scriptKind);
  const lines = input.content.length === 0 ? [] : input.content.split("\n");

  if (lines.length === 0) return [];

  const rawSpans = extractRawSpans(sourceFile);
  if (rawSpans.length === 0) {
    return chunkByLineWindow({ lines, firstLineNumber: 1, maxTokens: options.maxTokens, overlapTokens: options.overlapTokens });
  }

  const materialized = rawSpans
    .sort((a, b) => a.startLine - b.startLine)
    .flatMap((span) => materializeSpan(span, lines, options));

  return fillGaps(materialized, lines, options);
}

function extractRawSpans(sourceFile: ts.SourceFile): RawSpan[] {
  const spans: RawSpan[] = [];

  for (const stmt of sourceFile.statements) {
    if (ts.isFunctionDeclaration(stmt)) {
      spans.push(spanOf(sourceFile, stmt, stmt.name?.text ?? null, "function", null));
    } else if (ts.isClassDeclaration(stmt)) {
      spans.push(...classSpans(sourceFile, stmt));
    } else if (ts.isInterfaceDeclaration(stmt)) {
      spans.push(spanOf(sourceFile, stmt, stmt.name.text, "interface", null));
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      spans.push(spanOf(sourceFile, stmt, stmt.name.text, "type", null));
    } else if (ts.isEnumDeclaration(stmt)) {
      spans.push(spanOf(sourceFile, stmt, stmt.name.text, "enum", null));
    } else if (ts.isVariableStatement(stmt)) {
      spans.push(...variableStatementSpans(sourceFile, stmt));
    }
  }

  return spans;
}

function variableStatementSpans(sourceFile: ts.SourceFile, stmt: ts.VariableStatement): RawSpan[] {
  const decls = stmt.declarationList.declarations;
  if (decls.length !== 1) {
    // Multiple declarators on one statement (`const a = 1, b = 2;`) share a
    // line range that can't be cleanly split per-name — keep it as one span.
    return [spanOf(sourceFile, stmt, null, null, null)];
  }

  const decl = decls[0]!;
  const name = ts.isIdentifier(decl.name) ? decl.name.text : null;
  const isFunctionLike = !!decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));
  return [spanOf(sourceFile, stmt, name, isFunctionLike ? "function" : "variable", null)];
}

function classSpans(sourceFile: ts.SourceFile, node: ts.ClassDeclaration): RawSpan[] {
  const className = node.name?.text ?? null;
  const methods = node.members.filter(
    (m): m is ts.MethodDeclaration | ts.ConstructorDeclaration | ts.GetAccessorDeclaration | ts.SetAccessorDeclaration =>
      ts.isMethodDeclaration(m) || ts.isConstructorDeclaration(m) || ts.isGetAccessor(m) || ts.isSetAccessor(m)
  );

  if (methods.length === 0) {
    return [spanOf(sourceFile, node, className, "class", null)];
  }

  const signatureLine = lineText(sourceFile, node.getStart(sourceFile, true));
  return methods.map((member) => {
    const memberName = ts.isConstructorDeclaration(member) ? "constructor" : member.name?.getText(sourceFile);
    const qualifiedName = className && memberName ? `${className}.${memberName}` : (memberName ?? className);
    return spanOf(sourceFile, member, qualifiedName, "method", signatureLine);
  });
}

function spanOf(sourceFile: ts.SourceFile, node: ts.Node, symbolName: string | null, symbolType: SymbolType | null, contextPrefix: string | null): RawSpan {
  const start = node.getStart(sourceFile, true);
  const end = Math.max(node.getEnd() - 1, start);
  return {
    startLine: sourceFile.getLineAndCharacterOfPosition(start).line + 1,
    endLine: sourceFile.getLineAndCharacterOfPosition(end).line + 1,
    symbolName,
    symbolType,
    contextPrefix,
  };
}

function lineText(sourceFile: ts.SourceFile, pos: number): string {
  const line = sourceFile.getLineAndCharacterOfPosition(pos).line;
  const lineStarts = sourceFile.getLineStarts();
  const lineStart = lineStarts[line]!;
  const lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1]! : sourceFile.text.length;
  return sourceFile.text.slice(lineStart, lineEnd).replace(/\r?\n$/, "");
}

function materializeSpan(span: RawSpan, lines: string[], options: TsChunkOptions): ChunkSpec[] {
  const bodyLines = lines.slice(span.startLine - 1, span.endLine);
  const classHeader = span.contextPrefix ? `${span.contextPrefix}\n` : "";
  const wholeContent = classHeader + bodyLines.join("\n");
  const wholeTokens = estimateTokens(wholeContent);

  if (wholeTokens <= options.maxTokens) {
    return [
      {
        startLine: span.startLine,
        endLine: span.endLine,
        symbolName: span.symbolName,
        symbolType: span.symbolType,
        content: wholeContent,
        estimatedTokens: wholeTokens,
      },
    ];
  }

  // A window's own first line only carries the span's signature "for free" if
  // it's the very first window (which starts at bodyLines[0], the signature
  // itself) — every later window is a floating body fragment, so it needs the
  // signature (and, for a method, its class's signature) repeated so a reader
  // never loses "what symbol is this" partway through a split function.
  const signatureLine = bodyLines[0] ?? "";
  const repeatedHeader = classHeader + `${signatureLine}\n`;
  const headerTokens = estimateTokens(repeatedHeader);
  const windows = chunkByLineWindow({
    lines: bodyLines,
    firstLineNumber: span.startLine,
    maxTokens: Math.max(options.maxTokens - headerTokens, Math.floor(options.maxTokens / 2)),
    overlapTokens: options.overlapTokens,
  });

  return windows.map((w, i) => {
    const content = i === 0 ? classHeader + w.content : repeatedHeader + w.content;
    const suffix = windows.length > 1 ? `#${i + 1}` : "";
    return {
      startLine: w.startLine,
      endLine: w.endLine,
      symbolName: span.symbolName ? `${span.symbolName}${suffix}` : null,
      symbolType: span.symbolType,
      content,
      estimatedTokens: estimateTokens(content),
    };
  });
}

/** Sweeps up every line not covered by a named span (imports, bare statements, blank runs) into line-window chunks, so citations never point at a line that has no chunk. */
function fillGaps(spans: ChunkSpec[], lines: string[], options: TsChunkOptions): ChunkSpec[] {
  const result: ChunkSpec[] = [];
  let cursor = 1;

  const emitGap = (fromLine: number, toLineExclusive: number): void => {
    if (toLineExclusive <= fromLine) return;
    const gapLines = lines.slice(fromLine - 1, toLineExclusive - 1);
    if (!gapLines.some((l) => l.trim().length > 0)) return;
    result.push(...chunkByLineWindow({ lines: gapLines, firstLineNumber: fromLine, maxTokens: options.maxTokens, overlapTokens: options.overlapTokens }));
  };

  for (const span of spans) {
    emitGap(cursor, span.startLine);
    result.push(span);
    cursor = Math.max(cursor, span.endLine + 1);
  }
  emitGap(cursor, lines.length + 1);

  return result;
}
