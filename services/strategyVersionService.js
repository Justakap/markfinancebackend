/**
 * Phase A — the only place allowed to create/advance a StrategyVersion.
 * Centralizing this is what makes ADR-001 (immutable versions) actually
 * hold in practice: nothing else should call
 * `StrategyVersion.create()`/`.updateOne()` directly.
 */

async function createStrategy({ StrategyDefinition, StrategyVersion, userId, name, description, definition }) {
    const strategy = await StrategyDefinition.create({
        userId,
        name,
        description: description || "",
    });

    const version = await StrategyVersion.create({
        strategyId: strategy._id,
        versionNumber: 1,
        definition,
    });

    strategy.currentVersionId = version._id;
    await strategy.save();

    return { strategy, version };
}

/**
 * Creates version N+1 for an existing strategy and repoints
 * `currentVersionId` at it. Never mutates a prior StrategyVersion
 * document — any existing BacktestResult referencing an older version
 * keeps referencing exactly what it always referenced.
 */
async function createNewVersion({ StrategyDefinition, StrategyVersion, strategyId, userId, definition }) {
    const strategy = await StrategyDefinition.findOne({ _id: strategyId, userId });
    if (!strategy) return null;

    const latest = await StrategyVersion.findOne({ strategyId }).sort({ versionNumber: -1 });
    const nextVersionNumber = (latest?.versionNumber || 0) + 1;

    const version = await StrategyVersion.create({
        strategyId,
        versionNumber: nextVersionNumber,
        definition,
    });

    strategy.currentVersionId = version._id;
    await strategy.save();

    return { strategy, version };
}

async function getCurrentVersion({ StrategyDefinition, StrategyVersion, strategyId, userId }) {
    const strategy = await StrategyDefinition.findOne({ _id: strategyId, userId });
    if (!strategy || !strategy.currentVersionId) return null;

    return StrategyVersion.findById(strategy.currentVersionId);
}

module.exports = {
    createStrategy,
    createNewVersion,
    getCurrentVersion,
};
