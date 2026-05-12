export type RequestedAppSurface = "workbench" | "operations";
export type ResolvedAppSurface = RequestedAppSurface | "auth";

export function resolveAppSurface(
  requestedSurface: RequestedAppSurface,
  options: {
    hasAuth: boolean;
    operatorUiEnabled: boolean;
  },
): ResolvedAppSurface {
  if (!options.hasAuth) {
    return "auth";
  }

  if (requestedSurface === "operations" && options.operatorUiEnabled) {
    return "operations";
  }

  return "workbench";
}
