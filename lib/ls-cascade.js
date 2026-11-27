/**
 * Language Server Cascade Status & Step Usage Parsers.
 * Extracts normalized cascade status metadata from GetAllCascadeTrajectories
 * and exact prompt/cache token usage from GetCascadeTrajectorySteps.
 */

/**
 * Returns a trimmed non-empty string for the first valid string candidate, or null.
 * @param {...*} values
 * @returns {string|null}
 */
function pickFirstNonEmptyString(...values) {
  for (const val of values) {
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return null;
}

/**
 * Returns true if value is a non-null, non-array object.
 * @param {*} value
 * @returns {boolean}
 */
function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Parses an optional non-negative finite token count from a number or numeric string.
 * Returns null if the field is present and invalid; returns 0 when omitted.
 * @param {*} value
 * @returns {{ valid: boolean, present: boolean, value: number }}
 */
function parseTokenField(value) {
  if (value === undefined || value === null) {
    return { valid: true, present: false, value: 0 };
  }
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0
      ? { valid: true, present: true, value }
      : { valid: false, present: true, value: 0 };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
      return { valid: false, present: true, value: 0 };
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= 0
      ? { valid: true, present: true, value: parsed }
      : { valid: false, present: true, value: 0 };
  }
  return { valid: false, present: true, value: 0 };
}

/**
 * Parses raw GetAllCascadeTrajectories payload into a Map keyed by conversationId.
 * @param {Object} rawData
 * @returns {Map<string, Object>}
 */
export function parseCascadeStatuses(rawData) {
  const summaries = rawData?.trajectorySummaries ?? rawData?.response?.trajectorySummaries;
  if (!isRecord(summaries)) {
    return new Map();
  }

  const statusMap = new Map();
  for (const [rawId, summary] of Object.entries(summaries)) {
    const conversationId = typeof rawId === "string" ? rawId.trim() : "";
    if (!conversationId || !isRecord(summary)) {
      continue;
    }

    const status = typeof summary.status === "string" ? summary.status.trim() : "";
    const isIdle =
      !status ||
      status === "CASCADE_RUN_STATUS_IDLE" ||
      status === "CASCADE_RUN_STATUS_UNSPECIFIED";

    const primaryMeta = isRecord(summary.metadata) ? summary.metadata : null;
    const fallbackMeta = isRecord(summary.trajectoryMetadata) ? summary.trajectoryMetadata : null;

    const rootConversationId = pickFirstNonEmptyString(
      primaryMeta?.rootConversationId,
      fallbackMeta?.rootConversationId,
      summary.rootConversationId
    );
    const parentConversationId = pickFirstNonEmptyString(
      primaryMeta?.parentConversationId,
      fallbackMeta?.parentConversationId,
      summary.parentConversationId
    );
    const subagentType = pickFirstNonEmptyString(
      primaryMeta?.subagentSpec?.typeName,
      fallbackMeta?.subagentSpec?.typeName,
      primaryMeta?.agentScript?.name,
      fallbackMeta?.agentScript?.name,
      summary.subagentSpec?.typeName,
      summary.agentScript?.name
    );
    const subagentRole = pickFirstNonEmptyString(
      primaryMeta?.subagentSpec?.role,
      fallbackMeta?.subagentSpec?.role,
      summary.subagentSpec?.role
    );
    const title = pickFirstNonEmptyString(summary.summary);
    const latestTerminationReason = pickFirstNonEmptyString(summary.latestExecutorTerminationReason);

    statusMap.set(conversationId, {
      status,
      isIdle,
      isRunning:
        status === "CASCADE_RUN_STATUS_RUNNING" ||
        status === "CASCADE_RUN_STATUS_BUSY" ||
        status === "CASCADE_RUN_STATUS_CANCELING",
      rootConversationId,
      parentConversationId,
      subagentType,
      title,
      subagentRole,
      latestTerminationReason,
      lastModifiedTime: pickFirstNonEmptyString(summary.lastModifiedTime)
    });
  }

  return statusMap;
}

/**
 * Inspects the trailing steps of a GetCascadeTrajectorySteps payload for waiting state.
 * @param {Object} rawData
 * @returns {{ isWaitingForUser: boolean, waitingToolName: string|null }}
 */
export function extractStepExecutionState(rawData) {
  const steps = Array.isArray(rawData?.steps)
    ? rawData.steps
    : Array.isArray(rawData?.response?.steps)
      ? rawData.response.steps
      : [];

  const start = Math.max(0, steps.length - 8);
  for (let i = steps.length - 1; i >= start; i -= 1) {
    const step = steps[i];
    if (step?.status === "CORTEX_STEP_STATUS_WAITING") {
      return {
        isWaitingForUser: true,
        waitingToolName: pickFirstNonEmptyString(
          step?.metadata?.toolCall?.name,
          step?.metadata?.toolName,
          step?.toolCall?.name
        )
      };
    }
  }
  return { isWaitingForUser: false, waitingToolName: null };
}

/**
 * Scans GetCascadeTrajectorySteps response backwards for the latest valid `metadata.modelUsage`
 * and trailing waiting-for-user status.
 * @param {Object} rawData
 * @returns {{ inputTokens: number, cacheReadTokens: number, cacheCreationTokens: number, outputTokens: number, totalPromptTokens: number, model: string|null, isWaitingForUser: boolean, waitingToolName: string|null }|null}
 */
export function extractLatestModelUsage(rawData) {
  const steps = Array.isArray(rawData?.steps)
    ? rawData.steps
    : Array.isArray(rawData?.response?.steps)
      ? rawData.response.steps
      : [];
  const { isWaitingForUser, waitingToolName } = extractStepExecutionState(rawData);

  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    const usage = step?.metadata?.modelUsage;
    if (!isRecord(usage)) continue;

    const input = parseTokenField(usage.inputTokens);
    const cacheRead = parseTokenField(usage.cacheReadTokens);
    const cacheCreation = parseTokenField(usage.cacheCreationTokens);
    const output = parseTokenField(usage.outputTokens);

    if (!input.valid || !cacheRead.valid || !cacheCreation.valid || !output.valid) {
      continue;
    }
    if (!input.present && !cacheRead.present && !cacheCreation.present && !output.present) {
      continue;
    }

    const totalPromptTokens = cacheRead.value + cacheCreation.value + input.value;
    const model = pickFirstNonEmptyString(
      usage.model,
      step?.metadata?.model,
      step?.metadata?.generatorMetadata?.model
    );

    return {
      inputTokens: input.value,
      cacheReadTokens: cacheRead.value,
      cacheCreationTokens: cacheCreation.value,
      outputTokens: output.value,
      totalPromptTokens,
      model,
      isWaitingForUser,
      waitingToolName
    };
  }

  if (isWaitingForUser) {
    return {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      totalPromptTokens: 0,
      model: null,
      isWaitingForUser: true,
      waitingToolName
    };
  }

  return null;
}
