/**
 * Block Grok Bot actors from account-security and billing mutations.
 * Human sessions (no actorType, or actorType !== "grokbot") pass through.
 */
export function isGrokBotActor(req) {
  return req?.user?.actorType === "grokbot";
}

export function forbidGrokBot(req, res, next) {
  if (!isGrokBotActor(req)) {
    return next();
  }

  return res.status(403).json({
    error: "This action is not available to Grok Bot logins.",
    message: "This action is not available to Grok Bot logins.",
    code: "GROKBOT_FORBIDDEN",
  });
}

export default forbidGrokBot;
