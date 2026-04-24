import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  findCommandByNativeName,
  isCommandEnabled,
  maybeResolveTextAlias,
  shouldHandleTextCommands,
} from "../commands-registry.js";
import type { FinalizedMsgContext } from "../templating.js";

function resolveFirstContextText(
  ctx: FinalizedMsgContext,
  keys: Array<"BodyForAgent" | "BodyForCommands" | "CommandBody" | "RawBody" | "Body">,
): string {
  for (const key of keys) {
    const value = ctx[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function resolveCommandCandidateText(ctx: FinalizedMsgContext): string {
  return resolveFirstContextText(ctx, ["CommandBody", "BodyForCommands", "RawBody", "Body"]).trim();
}

function isResetCommandCandidate(text: string): boolean {
  return /^\/(?:new|reset)(?:\s|$)/i.test(text);
}

export function shouldBypassAcpDispatchForCommand(
  ctx: FinalizedMsgContext,
  cfg: OpenClawConfig,
): boolean {
  const candidate = resolveCommandCandidateText(ctx);
  if (!candidate) {
    return false;
  }
  const normalized = candidate.trim();
  const allowTextCommands = shouldHandleTextCommands({
    cfg,
    surface: ctx.Surface ?? ctx.Provider ?? "",
    commandSource: ctx.CommandSource,
  });
  if (!normalized.startsWith("/") && maybeResolveTextAlias(candidate, cfg) != null) {
    return allowTextCommands;
  }

  if (isResetCommandCandidate(normalized)) {
    return true;
  }

  // Bypass ACP for any registered native chat command (e.g., /model, /models,
  // /help, /status, /think) so they reach OpenClaw's native handlers and emit
  // the right interactive replies (model picker, help text, etc.) instead of
  // being forwarded to an ACP harness as plain text. /acp itself is excluded
  // because it manages the ACP runtime and must stay there.
  if (normalized.startsWith("/")) {
    const slashName = normalized.slice(1).split(/\s+/, 1)[0]?.toLowerCase() ?? "";
    if (slashName && slashName !== "acp") {
      const provider = ctx.Surface ?? ctx.Provider ?? "";
      if (findCommandByNativeName(slashName, provider)) {
        return allowTextCommands;
      }
    }
  }

  if (!normalized.startsWith("!")) {
    return false;
  }

  if (!ctx.CommandAuthorized) {
    return false;
  }

  if (!isCommandEnabled(cfg, "bash")) {
    return false;
  }

  return allowTextCommands;
}
