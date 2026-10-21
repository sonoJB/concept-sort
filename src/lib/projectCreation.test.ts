import { describe, expect, it } from "vitest";
import { projectCreationAllowed } from "./projectCreation";

describe("project creation gate", () => {
  it("is closed in production unless explicitly enabled, open elsewhere", () => {
    expect(projectCreationAllowed({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toBe(false);
    expect(projectCreationAllowed({ NODE_ENV: "production", ALLOW_PROJECT_CREATION: "0" } as NodeJS.ProcessEnv)).toBe(false);
    expect(projectCreationAllowed({ NODE_ENV: "production", ALLOW_PROJECT_CREATION: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(projectCreationAllowed({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toBe(true);
    expect(projectCreationAllowed({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).toBe(true);
  });
});
