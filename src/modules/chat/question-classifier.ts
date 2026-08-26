import type { RetrievalFilters } from "@aca/contracts";

export type QuestionClass = "file" | "symbol" | "architecture" | "change" | "general";

export interface ClassificationResult {
  questionClass: QuestionClass;
  /** The file path mentioned in the question, when the `file`/`change` classes found one — used for path-prefix retrieval and, for `change`, to look up importers in the dependency graph. */
  targetPath?: string;
  /** The identifier mentioned, when the `symbol` class found one — used for a symbol-name lexical prefilter. */
  targetSymbol?: string;
  filters: RetrievalFilters;
}

// A path-looking token: has a `/` or a recognized source-file extension. Deliberately permissive — a false
// positive just widens retrieval filters slightly, it never blocks an answer. The bare-filename alternative
// allows any number of `.segment` groups before the final extension — without it, "app.component.ts" would
// match only its last two segments ("component.ts"), which then fails to prefix-match the real path.
const FILE_PATH_RE =
  /[\w./-]*\/[\w./-]+|\b[\w-]+(?:\.[\w-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|c|cpp|h|hpp|cs|sql|md|json|ya?ml)\b/i;
// Requires a genuine camelCase/PascalCase hump (a second capital after a lowercase run), not just a
// sentence-initial capitalized word — "What does..." must not look like an identifier, "AuthService" must.
const SYMBOL_RE = /\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*\b|\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/;
const CHANGE_RE = /\b(add|implement|fix|refactor|migrate|create|remove|delete|update|change)\b/i;
const ARCHITECTURE_RE = /\bhow does\b|\bflow\b|\bstructure\b|\bwhy\b|\bwhere is\b.*\bhandled\b|\barchitecture\b/i;
const SYMBOL_KEYWORD_RE = /\b(class|function|method|interface|type|enum)\b/i;

/**
 * Cheap, deterministic routing before retrieval — no model call
 * (CHAT_SERVICE_PLAN.md "Question Classification", LLM_PROMPTING.md
 * "Question Classification"). `change` is checked first: a change request
 * often also names a file or symbol, and when it does the plan wants both
 * the change-question behavior (importers included) AND the narrower
 * target filter, not one or the other.
 */
export function classifyQuestion(text: string): ClassificationResult {
  const pathMatch = text.match(FILE_PATH_RE);
  const targetPath = pathMatch?.[0];

  if (CHANGE_RE.test(text)) {
    const symbolMatch = !targetPath ? findSymbolMatch(text) : undefined;
    return {
      questionClass: "change",
      targetPath,
      targetSymbol: symbolMatch,
      filters: pathFilterFor(targetPath),
    };
  }

  if (targetPath) {
    return { questionClass: "file", targetPath, filters: pathFilterFor(targetPath) };
  }

  if (SYMBOL_KEYWORD_RE.test(text)) {
    const targetSymbol = findSymbolMatch(text);
    return { questionClass: "symbol", targetSymbol, filters: {} };
  }

  // Phrase-based architecture signals outrank a loose identifier match: "How does AuthService
  // validate tokens?" mentions a symbol incidentally but is asking about relationships, not the symbol itself.
  if (ARCHITECTURE_RE.test(text)) {
    return { questionClass: "architecture", filters: {} };
  }

  const symbolMatch = findSymbolMatch(text);
  if (symbolMatch) {
    return { questionClass: "symbol", targetSymbol: symbolMatch, filters: {} };
  }

  return { questionClass: "general", filters: {} };
}

function findSymbolMatch(text: string): string | undefined {
  const match = text.match(SYMBOL_RE);
  return match?.[0];
}

/**
 * `pathPrefix` is a strict `LIKE 'prefix%'` match — appropriate for a genuine
 * partial directory path, actively harmful for a bare filename that's
 * actually nested somewhere ("app.component.ts" would filter out the real
 * "src/app/app.component.ts", zeroing retrieval instead of narrowing it). A
 * bare filename still reaches the retrieval query text as-is; it just isn't
 * used as a metadata filter that can wrongly exclude everything.
 */
function pathFilterFor(targetPath: string | undefined): RetrievalFilters {
  return targetPath?.includes("/") ? { pathPrefix: targetPath } : {};
}
