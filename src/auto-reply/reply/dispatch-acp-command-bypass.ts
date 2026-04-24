// Detects ACP commands that should bypass normal agent dispatch.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasControlCommand } from "../command-detection.js";
import { findCommandByNativeName } from "../commands-registry.js";
import { isCommandEnabled } from "../commands-registry-list.js";
import { maybeResolveTextAlias } from "../commands-registry-normalize.js";
import { shouldHandleTextCommands } from "../commands-text-routing.js";
import type { FinalizedRuntimeMsgContext } from "../templating.js";
import { resolveCommandContextText } from "./context-text.js";

function isResetCommandCandidate(text: string): boolean {
  return /^\/(?:new|reset)(?:\s|$)/i.test(text);
}

function isAcpCommandCandidate(text: string): boolean {
  return /^\/acp(?:\s|$)/i.test(text);
}

function isLocalCommandCandidate(text: string, cfg: OpenClawConfig): boolean {
  return hasControlCommand(text, cfg);
}

export function shouldBypassAcpDispatchForCommand(
  ctx: FinalizedRuntimeMsgContext,
  cfg: OpenClawConfig,
): boolean {
  const candidate = resolveCommandContextText(ctx);
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

  if (isAcpCommandCandidate(normalized)) {
    return true;
  }

  if (isLocalCommandCandidate(normalized, cfg)) {
    return allowTextCommands;
  }

  // Bypass ACP for any registered native chat command (e.g., /model, /models,
  // /help, /think) so they reach OpenClaw's native handlers and emit the right
  // interactive replies (model picker, help text, etc.) instead of being
  // forwarded to an ACP harness as plain text. /acp is handled above.
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
