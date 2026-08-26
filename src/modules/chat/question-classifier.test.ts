import { describe, expect, it } from "vitest";
import { classifyQuestion } from "./question-classifier";

describe("classifyQuestion", () => {
  it("classifies a quoted file path as `file`", () => {
    const result = classifyQuestion("What does src/modules/auth/auth.service.ts do?");
    expect(result.questionClass).toBe("file");
    expect(result.targetPath).toBe("src/modules/auth/auth.service.ts");
    expect(result.filters.pathPrefix).toBe("src/modules/auth/auth.service.ts");
  });

  it("classifies a bare filename with extension as `file`", () => {
    const result = classifyQuestion("What does main.ts do?");
    expect(result.questionClass).toBe("file");
    expect(result.targetPath).toBe("main.ts");
  });

  it("captures the full multi-dot filename, not just its last two segments", () => {
    const result = classifyQuestion("What does the onMouseMove method in app.component.ts do?");
    expect(result.targetPath).toBe("app.component.ts");
  });

  it("does not set a pathPrefix filter for a bare filename — it would wrongly exclude the real nested path", () => {
    const result = classifyQuestion("What does app.component.ts do?");
    expect(result.targetPath).toBe("app.component.ts");
    expect(result.filters.pathPrefix).toBeUndefined();
  });

  it("classifies an explicit symbol keyword as `symbol`", () => {
    const result = classifyQuestion("What does the bootstrap function do?");
    expect(result.questionClass).toBe("symbol");
  });

  it("classifies a bare identifier mention as `symbol`", () => {
    const result = classifyQuestion("What is UserRepository?");
    expect(result.questionClass).toBe("symbol");
    expect(result.targetSymbol).toBe("UserRepository");
  });

  it("classifies an architectural phrase as `architecture` even when a symbol is mentioned incidentally", () => {
    const result = classifyQuestion("How does AuthService validate tokens?");
    expect(result.questionClass).toBe("architecture");
  });

  it("classifies 'flow' and 'structure' questions as `architecture`", () => {
    expect(classifyQuestion("Explain the request flow").questionClass).toBe("architecture");
    expect(classifyQuestion("What is the folder structure?").questionClass).toBe("architecture");
  });

  it("classifies a change verb as `change`, capturing the target path", () => {
    const result = classifyQuestion("Fix the bug in src/app.ts");
    expect(result.questionClass).toBe("change");
    expect(result.targetPath).toBe("src/app.ts");
  });

  it("classifies 'add'/'implement'/'refactor' as `change`", () => {
    expect(classifyQuestion("Add a new endpoint for user profiles").questionClass).toBe("change");
    expect(classifyQuestion("Implement rate limiting").questionClass).toBe("change");
    expect(classifyQuestion("Refactor the retry logic").questionClass).toBe("change");
  });

  it("falls back to `general` for a plain question with no signals", () => {
    const result = classifyQuestion("What does this project do?");
    expect(result.questionClass).toBe("general");
    expect(result.targetPath).toBeUndefined();
  });
});
