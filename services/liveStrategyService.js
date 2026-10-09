/**
 * Workstream J — activation/deactivation orchestration for
 * LiveStrategyRuntime, kept separate from routes/liveStrategyRoutes.js so
 * the route stays thin (same convention as
 * services/professionalBacktestService.js vs. professionalBacktestRoutes.js).
 */

const { createInitialEngineState } = require("./liveSignalEngine");
const { validateStrategyDefinition } = require("../utils/strategyExpression");

function makeError(statusCode, message) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.clientMessage = message;
    return error;
}

/**
 * Ownership is enforced the same way as every other professional route:
 * the strategy must belong to `userId`, and the version must belong to
 * that strategy — never resolved by id alone. `strategyVersionId` is
 * optional in the request; it defaults to the strategy's current version
 * at the moment of activation (then frozen, per the file doc comment in
 * LiveStrategyRuntime.js).
 */
async function activateLiveStrategy({
    models: { StrategyDefinition, StrategyVersion, LiveStrategyRuntime },
    userId,
    strategyId,
    strategyVersionId,
    instrumentKey,
    symbol,
    timeframe,
    initialCapital,
    commissionPct,
    slippagePct,
}) {
    const strategy = await StrategyDefinition.findOne({ _id: strategyId, userId });
    if (!strategy) {
        throw makeError(404, "Strategy not found");
    }

    const targetVersionId = strategyVersionId || strategy.currentVersionId;
    if (!targetVersionId) {
        throw makeError(400, "This strategy has no saved version to activate");
    }

    const version = await StrategyVersion.findOne({ _id: targetVersionId, strategyId: strategy._id });
    if (!version) {
        throw makeError(404, "Strategy version not found");
    }

    // Defensive re-validation, same discipline as
    // professionalBacktestService.js: a version is already validated at
    // save time (professionalStrategyRoutes.js), but never trust a
    // persisted document to still satisfy every current rule (e.g. an
    // indicator registry change since this version was created) without
    // checking again before it's used to drive real evaluation.
    try {
        validateStrategyDefinition(version.definition);
    } catch (error) {
        throw makeError(400, error.clientMessage || "Invalid strategy definition");
    }

    if (version.definition?.universe?.timeframe !== timeframe) {
        throw makeError(
            400,
            `This strategy version was authored for the "${version.definition?.universe?.timeframe}" timeframe — activate it with that timeframe, not "${timeframe}".`,
        );
    }

    let runtime;
    try {
        runtime = await LiveStrategyRuntime.create({
            userId,
            strategyId: strategy._id,
            strategyVersionId: version._id,
            instrumentKey,
            symbol,
            timeframe,
            status: "ACTIVE",
            config: { initialCapital, commissionPct, slippagePct },
            engineState: createInitialEngineState(initialCapital),
            lastProcessedCandleTimestamp: null,
            lastEvaluationAt: null,
            lastEvaluationStatus: "Activated — awaiting first completed candle",
        });
    } catch (error) {
        if (error.code === 11000) {
            throw makeError(409, "This strategy is already active for this instrument and timeframe. Deactivate it first.");
        }
        throw error;
    }

    return { runtime, strategy, version };
}

async function deactivateLiveStrategy({ models: { LiveStrategyRuntime }, userId, runtimeId }) {
    const runtime = await LiveStrategyRuntime.findOneAndUpdate(
        { _id: runtimeId, userId, status: "ACTIVE" },
        { $set: { status: "INACTIVE", deactivatedAt: new Date() } },
        { returnDocument: "after" },
    );
    if (!runtime) {
        throw makeError(404, "Active live strategy runtime not found");
    }
    return runtime;
}

module.exports = { activateLiveStrategy, deactivateLiveStrategy, makeError };
