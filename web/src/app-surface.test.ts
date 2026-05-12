import { describe, expect, it } from "vitest";

import { resolveAppSurface } from "./app-surface";

describe("resolveAppSurface", () => {
  it("routes unauthenticated sessions to the auth gate", () => {
    expect(
      resolveAppSurface("workbench", {
        hasAuth: false,
        operatorUiEnabled: false,
      }),
    ).toBe("auth");
    expect(
      resolveAppSurface("operations", {
        hasAuth: false,
        operatorUiEnabled: true,
      }),
    ).toBe("auth");
  });

  it("keeps authenticated users on the workbench by default", () => {
    expect(
      resolveAppSurface("workbench", {
        hasAuth: true,
        operatorUiEnabled: false,
      }),
    ).toBe("workbench");
  });

  it("only allows the operations surface when operator ui is enabled", () => {
    expect(
      resolveAppSurface("operations", {
        hasAuth: true,
        operatorUiEnabled: true,
      }),
    ).toBe("operations");
    expect(
      resolveAppSurface("operations", {
        hasAuth: true,
        operatorUiEnabled: false,
      }),
    ).toBe("workbench");
  });
});
