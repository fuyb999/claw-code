import type { ThreadSnapshot } from "./types";

type RuntimeErrorPresentation = {
  userMessage: string;
  shortLabel?: string;
  actionHint?: string;
};

function includesAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

export function presentRuntimeError(message: string | null | undefined): RuntimeErrorPresentation | null {
  const normalized = message?.trim();
  if (!normalized || normalized === "run interrupted") {
    return null;
  }

  if (normalized === "Failed to fetch") {
    return {
      userMessage: "服务连接暂时不可用，请确认后端已启动，并检查当前 API 地址与访问凭据。",
      shortLabel: "连接失败",
      actionHint: "稍后重试，或检查服务状态与网络连通性。",
    };
  }

  if (
    includesAny(normalized, [
      "missing Anthropic credentials",
      "missing OpenAI credentials",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "XAI_API_KEY",
      "DASHSCOPE_API_KEY",
    ])
  ) {
    return {
      userMessage: "模型服务尚未配置可用凭据，当前会话暂时无法继续运行。",
      shortLabel: "模型未配置",
      actionHint: "请在设置里填写可用的 API 地址和 API 密钥，或由服务启动环境提供相应凭据。",
    };
  }

  if (
    includesAny(normalized, [
      "insufficient_quota",
      "额度用完",
      "套餐已经到期",
      "quota",
    ])
  ) {
    return {
      userMessage: "模型服务当前额度不足，这轮任务没有继续完成。",
      shortLabel: "额度不足",
      actionHint: "请检查当前模型代理账户余额、套餐或速率限制后再重试。",
    };
  }

  if (
    includesAny(normalized, [
      "401",
      "403",
      "unauthorized",
      "forbidden",
      "invalid api key",
      "authentication",
      "auth missing",
      "api_key",
    ])
  ) {
    return {
      userMessage: "模型服务拒绝了当前请求，请检查 API 密钥、接口地址或服务端鉴权配置。",
      shortLabel: "鉴权失败",
      actionHint: "确认当前地址与密钥是否匹配，必要时重新填写后再试。",
    };
  }

  return {
    userMessage: normalized,
  };
}

export function presentThreadAlert(thread: ThreadSnapshot | null): string | null {
  if (!thread?.last_error) {
    return null;
  }

  if (!thread.messages.length && !thread.draft_assistant_text.trim()) {
    return null;
  }

  if (thread.status === "interrupt_requested") {
    return "正在停止当前任务…";
  }

  return presentRuntimeError(thread.last_error)?.userMessage ?? thread.last_error;
}
