import {
  buildProtectedDisclosureReply,
  buildSelfPolicingSystemAppendix,
  buildSessionDisengagedReply,
  detectAssistantRefusal,
  isolateUserContentForModel,
  prepareProtectedUserMessageSemantic,
  validateAssistantDisclosureReplySemantic,
} from "../security/trade-secret-guard.js";
import { isSessionDisengaged, recordRefusalStrike } from "../security/session-strike-counter.js";

type GuardContext = {
  ip?: string | null;
  sessionId: string;
  userAgent?: string | null;
  userId?: string | null;
};

export type GuardedDirectiveResult =
  | {
      allowed: false;
      disengaged: boolean;
      firedWebhook: boolean;
      response: string;
      strikeCount: number;
    }
  | {
      allowed: true;
      message: string;
      modelTurn: {
        appendixAttached: true;
        systemAppendix: string;
        userMessage: string;
      };
    };

export type GuardedAssistantReplyResult = {
  disengaged: boolean;
  firedWebhook: boolean;
  refusalDetected: boolean;
  response: string;
  strikeCount: number;
};

export async function prepareDirectiveForModel(
  input: GuardContext & { message: string },
): Promise<GuardedDirectiveResult> {
  if (
    await isSessionDisengaged({
      ip: input.ip,
      sessionId: input.sessionId,
      userId: input.userId ?? null,
    })
  ) {
    return {
      allowed: false,
      disengaged: true,
      firedWebhook: false,
      response: buildSessionDisengagedReply(),
      strikeCount: 3,
    };
  }

  const assessment = await prepareProtectedUserMessageSemantic(input.message);
  if (assessment.blocked || !assessment.modelMessage) {
    const strike = await recordRefusalStrike({
      direction: "input",
      flaggedText: input.message,
      ip: input.ip,
      reason: assessment.reason ?? "protected-disclosure-attempt",
      sessionId: input.sessionId,
      userAgent: input.userAgent,
      userId: input.userId ?? null,
    });

    return {
      allowed: false,
      disengaged: strike.disengaged,
      firedWebhook: strike.firedWebhook,
      response: strike.disengaged ? buildSessionDisengagedReply() : buildProtectedDisclosureReply(),
      strikeCount: strike.strikeCount,
    };
  }

  const message = assessment.modelMessage;
  return {
    allowed: true,
    message,
    modelTurn: {
      appendixAttached: true,
      systemAppendix: buildSelfPolicingSystemAppendix(),
      userMessage: isolateUserContentForModel(message),
    },
  };
}

export async function validateAssistantReply(
  input: GuardContext & { message: string },
): Promise<GuardedAssistantReplyResult> {
  if (
    await isSessionDisengaged({
      ip: input.ip,
      sessionId: input.sessionId,
      userId: input.userId ?? null,
    })
  ) {
    return {
      disengaged: true,
      firedWebhook: false,
      refusalDetected: true,
      response: buildSessionDisengagedReply(),
      strikeCount: 3,
    };
  }

  const response = await validateAssistantDisclosureReplySemantic(input.message);
  const refusalDetected = detectAssistantRefusal(response);
  if (!refusalDetected) {
    return {
      disengaged: false,
      firedWebhook: false,
      refusalDetected: false,
      response,
      strikeCount: 0,
    };
  }

  const strike = await recordRefusalStrike({
    direction: "output",
    flaggedText: input.message,
    ip: input.ip,
    reason: "assistant-refusal-detected",
    sessionId: input.sessionId,
    userAgent: input.userAgent,
    userId: input.userId ?? null,
  });

  return {
    disengaged: strike.disengaged,
    firedWebhook: strike.firedWebhook,
    refusalDetected: true,
    response: strike.disengaged ? buildSessionDisengagedReply() : response,
    strikeCount: strike.strikeCount,
  };
}
