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

const MAX_VERSION_CREATE_ATTEMPTS = 5;

/**
 * Creates version N+1 for an existing strategy and repoints
 * `currentVersionId` at it. Never mutates a prior StrategyVersion
 * document — any existing BacktestResult referencing an older version
 * keeps referencing exactly what it always referenced.
 *
 * Phase F.6 fix: the previous implementation read the latest
 * versionNumber and then created N+1 with no protection against a
 * concurrent caller doing the same read before either insert landed —
 * a classic read-then-write race that could either produce a duplicate
 * versionNumber or (depending on timing) throw and lose the second
 * caller's version entirely. This now retries on a duplicate-key error
 * from the existing unique {strategyId, versionNumber} index (Phase A),
 * re-reading the latest version each attempt, so two concurrent calls
 * always end up with two distinct, correctly-incrementing version
 * numbers — neither is ever silently dropped.
 *
 * Note on `currentVersionId` under concurrency: both versions are always
 * persisted immutably; only the *pointer* to "the current version" is a
 * last-write-wins race between the two `strategy.save()` calls. This is
 * accepted, documented behavior (see ADR-009) — no version data is ever
 * lost, only which one the pointer happens to land on.
 */
async function createNewVersion({ StrategyDefinition, StrategyVersion, strategyId, userId, definition }) {
    const strategy = await StrategyDefinition.findOne({ _id: strategyId, userId });
    if (!strategy) return null;

    let lastError = null;

    for (let attempt = 0; attempt < MAX_VERSION_CREATE_ATTEMPTS; attempt += 1) {
        const latest = await StrategyVersion.findOne({ strategyId }).sort({ versionNumber: -1 });
        const nextVersionNumber = (latest?.versionNumber || 0) + 1;

        try {
            // eslint-disable-next-line no-await-in-loop -- intentionally
            // sequential: each attempt must see the result of any
            // concurrent winner before computing its own next number.
            const version = await StrategyVersion.create({
                strategyId,
                versionNumber: nextVersionNumber,
                definition,
            });

            strategy.currentVersionId = version._id;
            // eslint-disable-next-line no-await-in-loop
            await strategy.save();

            return { strategy, version };
        } catch (error) {
            const isDuplicateVersionNumber = error?.code === 11000;
            if (!isDuplicateVersionNumber) throw error;
            lastError = error;
            // A concurrent caller took `nextVersionNumber` first — loop
            // again and re-read the (now-updated) latest version.
        }
    }

    throw lastError || new Error("Failed to create a new strategy version after multiple attempts");
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
