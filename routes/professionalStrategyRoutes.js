const express = require("express");
const { validateStrategyDefinition } = require("../utils/strategyExpression");

/**
 * Phase F.6 — authenticated CRUD for the professional system's
 * StrategyDefinition/StrategyVersion models. Completely separate from the
 * legacy `/api/strategies` (routes/strategyRoutes.js, untouched) — same
 * reasoning as Phase 2.1B/F.5's dedicated-route precedent: a different
 * data model deserves its own endpoint, not a shared/branching one.
 *
 * All version creation goes through strategyVersionService.js (Phase A,
 * fixed for concurrency in this phase) - this file never calls
 * StrategyVersion.create()/.save() directly.
 */

const NAME_MAX_LENGTH = 200;
const DESCRIPTION_MAX_LENGTH = 2000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// Every field a client may set on StrategyDefinition directly (metadata
// only - `definition`/versioning never goes through a raw field update,
// see strategyVersionService.js). Mirrors routes/strategyRoutes.js's
// STRATEGY_WRITABLE_FIELDS/pickStrategyFields pattern for the legacy
// system (the same Phase 2.0 finding - never pass raw req.body into a
// Mongo update - applies here just as much).
const STRATEGY_METADATA_WRITABLE_FIELDS = ["name", "description", "status"];

function pickMetadataFields(body = {}) {
    const picked = {};
    STRATEGY_METADATA_WRITABLE_FIELDS.forEach((field) => {
        if (body[field] !== undefined) picked[field] = body[field];
    });
    return picked;
}

function validateName(name) {
    if (typeof name !== "string" || !name.trim()) {
        return "name is required";
    }
    if (name.length > NAME_MAX_LENGTH) {
        return `name must be ${NAME_MAX_LENGTH} characters or fewer`;
    }
    return null;
}

function validateDescription(description) {
    if (description === undefined) return null;
    if (typeof description !== "string") return "description must be a string";
    if (description.length > DESCRIPTION_MAX_LENGTH) {
        return `description must be ${DESCRIPTION_MAX_LENGTH} characters or fewer`;
    }
    return null;
}

function validateStatus(status) {
    if (status === undefined) return null;
    if (status !== "ACTIVE" && status !== "ARCHIVED") {
        return 'status must be "ACTIVE" or "ARCHIVED"';
    }
    return null;
}

function parsePagination(query) {
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(query.limit, 10) || DEFAULT_PAGE_SIZE));
    return { page, limit, skip: (page - 1) * limit };
}

function strategySummary(strategy) {
    return {
        strategyId: strategy._id,
        name: strategy.name,
        description: strategy.description,
        status: strategy.status,
        currentVersionId: strategy.currentVersionId,
        createdAt: strategy.createdAt,
        updatedAt: strategy.updatedAt,
    };
}

function versionSummary(version) {
    return {
        versionId: version._id,
        strategyId: version.strategyId,
        versionNumber: version.versionNumber,
        dslSchemaVersion: version.definition?.version ?? null,
        createdAt: version.createdAt,
    };
}

function versionDetail(version) {
    return {
        ...versionSummary(version),
        definition: version.definition,
    };
}

function createProfessionalStrategyRoutes({
    StrategyDefinition,
    StrategyVersion,
    requireAuth,
    validateObjectId,
    createStrategy,
    createNewVersion,
}) {
    const router = express.Router();

    router.post("/v2/strategies", requireAuth, async (req, res) => {
        try {
            const { name, description, definition } = req.body;

            const nameError = validateName(name);
            if (nameError) return res.status(400).json({ message: nameError });

            const descriptionError = validateDescription(description);
            if (descriptionError) return res.status(400).json({ message: descriptionError });

            if (!definition || typeof definition !== "object") {
                return res.status(400).json({ message: "definition is required" });
            }

            try {
                validateStrategyDefinition(definition);
            } catch (error) {
                return res.status(400).json({ message: error.clientMessage || "Invalid strategy definition" });
            }

            const { strategy, version } = await createStrategy({
                StrategyDefinition,
                StrategyVersion,
                userId: req.user.mongoId,
                name: name.trim(),
                description,
                definition,
            });

            return res.status(201).json({
                strategy: strategySummary(strategy),
                currentVersion: versionDetail(version),
            });
        } catch (error) {
            console.error("Create professional strategy error:", error);
            return res.status(500).json({ message: "Failed to create strategy" });
        }
    });

    router.get("/v2/strategies", requireAuth, async (req, res) => {
        try {
            const { page, limit, skip } = parsePagination(req.query);

            // Ownership enforced in the query itself, not just by
            // controller logic — this filter is the only thing standing
            // between "my strategies" and "everyone's strategies".
            const filter = { userId: req.user.mongoId };

            const [items, total] = await Promise.all([
                StrategyDefinition.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
                StrategyDefinition.countDocuments(filter),
            ]);

            return res.json({
                items: items.map(strategySummary),
                page,
                limit,
                total,
            });
        } catch (error) {
            console.error("List professional strategies error:", error);
            return res.status(500).json({ message: "Failed to list strategies" });
        }
    });

    router.get("/v2/strategies/:id", requireAuth, validateObjectId("id"), async (req, res) => {
        try {
            const strategy = await StrategyDefinition.findOne({ _id: req.params.id, userId: req.user.mongoId });
            if (!strategy) return res.status(404).json({ message: "Strategy not found" });

            const currentVersion = strategy.currentVersionId
                ? await StrategyVersion.findOne({ _id: strategy.currentVersionId, strategyId: strategy._id })
                : null;

            return res.json({
                strategy: strategySummary(strategy),
                currentVersion: currentVersion ? versionDetail(currentVersion) : null,
            });
        } catch (error) {
            console.error("Get professional strategy error:", error);
            return res.status(500).json({ message: "Failed to fetch strategy" });
        }
    });

    router.put("/v2/strategies/:id", requireAuth, validateObjectId("id"), async (req, res) => {
        try {
            const nameError = req.body.name !== undefined ? validateName(req.body.name) : null;
            if (nameError) return res.status(400).json({ message: nameError });

            const descriptionError = validateDescription(req.body.description);
            if (descriptionError) return res.status(400).json({ message: descriptionError });

            const statusError = validateStatus(req.body.status);
            if (statusError) return res.status(400).json({ message: statusError });

            if (req.body.definition !== undefined) {
                try {
                    validateStrategyDefinition(req.body.definition);
                } catch (error) {
                    return res.status(400).json({ message: error.clientMessage || "Invalid strategy definition" });
                }
            }

            const metadata = pickMetadataFields(req.body);
            if (metadata.name !== undefined) metadata.name = metadata.name.trim();

            let strategy;
            let newVersion = null;

            if (req.body.definition !== undefined) {
                // Definition changed -> a new immutable version, never an
                // edit to an existing one (ADR-001). This also validates
                // ownership (createNewVersion scopes its lookup by
                // {_id, userId}) and returns null for a strategy the
                // caller doesn't own.
                const result = await createNewVersion({
                    StrategyDefinition,
                    StrategyVersion,
                    strategyId: req.params.id,
                    userId: req.user.mongoId,
                    definition: req.body.definition,
                });
                if (!result) return res.status(404).json({ message: "Strategy not found" });
                strategy = result.strategy;
                newVersion = result.version;
            } else {
                strategy = await StrategyDefinition.findOne({ _id: req.params.id, userId: req.user.mongoId });
                if (!strategy) return res.status(404).json({ message: "Strategy not found" });
            }

            if (Object.keys(metadata).length > 0) {
                // Ownership-scoped update, field-whitelisted - never
                // req.body passed directly into a Mongo update (Phase 2.0
                // finding, same discipline as the legacy fix in Phase 2.2).
                strategy = await StrategyDefinition.findOneAndUpdate(
                    { _id: req.params.id, userId: req.user.mongoId },
                    metadata,
                    { returnDocument: "after" },
                );
            }

            return res.json({
                strategy: strategySummary(strategy),
                newVersion: newVersion ? versionDetail(newVersion) : null,
            });
        } catch (error) {
            console.error("Update professional strategy error:", error);
            return res.status(500).json({ message: "Failed to update strategy" });
        }
    });

    router.get("/v2/strategies/:id/versions", requireAuth, validateObjectId("id"), async (req, res) => {
        try {
            const strategy = await StrategyDefinition.findOne({ _id: req.params.id, userId: req.user.mongoId });
            if (!strategy) return res.status(404).json({ message: "Strategy not found" });

            const { page, limit, skip } = parsePagination(req.query);
            const filter = { strategyId: strategy._id };

            const [items, total] = await Promise.all([
                StrategyVersion.find(filter).sort({ versionNumber: -1 }).skip(skip).limit(limit),
                StrategyVersion.countDocuments(filter),
            ]);

            return res.json({
                items: items.map(versionSummary),
                page,
                limit,
                total,
            });
        } catch (error) {
            console.error("List professional strategy versions error:", error);
            return res.status(500).json({ message: "Failed to list versions" });
        }
    });

    router.get(
        "/v2/strategies/:id/versions/:versionId",
        requireAuth,
        validateObjectId("id", "versionId"),
        async (req, res) => {
            try {
                const strategy = await StrategyDefinition.findOne({ _id: req.params.id, userId: req.user.mongoId });
                if (!strategy) return res.status(404).json({ message: "Strategy not found" });

                const version = await StrategyVersion.findOne({
                    _id: req.params.versionId,
                    strategyId: strategy._id,
                });
                if (!version) return res.status(404).json({ message: "Strategy version not found" });

                return res.json(versionDetail(version));
            } catch (error) {
                console.error("Get professional strategy version error:", error);
                return res.status(500).json({ message: "Failed to fetch strategy version" });
            }
        },
    );

    return router;
}

module.exports = {
    createProfessionalStrategyRoutes,
    pickMetadataFields,
    STRATEGY_METADATA_WRITABLE_FIELDS,
};
