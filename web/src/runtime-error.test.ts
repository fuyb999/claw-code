import { describe, expect, it } from "vitest";

import { presentRuntimeError } from "./runtime-error";

describe("presentRuntimeError", () => {
  it("maps quota failures to a user-facing message", () => {
    expect(
      presentRuntimeError(
        "provider stream failed: api returned 403 Forbidden (insufficient_quota): 套餐已经到期",
      ),
    ).toMatchObject({
      shortLabel: "额度不足",
      userMessage: "模型服务当前额度不足，这轮任务没有继续完成。",
    });
  });

  it("maps missing credentials to a configuration message", () => {
    expect(
      presentRuntimeError(
        "missing OpenAI credentials; export OPENAI_API_KEY before calling the OpenAI API",
      ),
    ).toMatchObject({
      shortLabel: "模型未配置",
    });
  });

  it("maps auth failures to an auth message", () => {
    expect(
      presentRuntimeError("provider response failed: api returned 401 Unauthorized"),
    ).toMatchObject({
      shortLabel: "鉴权失败",
    });
  });
});
