const express = require("express");
const mongoose = require("mongoose");

/**
 * Workstream K — authenticated API for alert configurations (user
 * preferences for which LiveStrategyRuntime events to be notified about)
 * and persisted in-app notifications. Own `/v2/alert-configurations` and
 * `/v2/notifications` prefixes — separate from `/v2/live/*` (Workstream J)
 * and every legacy route, same ADR-006-style separation this codebase
 * already uses throughout.
 */

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function parsePagination(query) {
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(query.limit, 10) || DEFAULT_PAGE_SIZE));
    return { page, limit, skip: (page - 1) * limit };
}

function configSummary(config) {
    return {
        configId: config._id,
        runtimeId: config.runtimeId,
        strategyId: config.strategyId,
        eventTypes: config.eventTypes,
        enabled: config.enabled,
        status: config.status,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
    };
}

function notificationSummary(notification) {
    return {
        notificationId: notification._id,
        runtimeId: notification.runtimeId,
        strategyId: notification.strategyId,
        sourceSignalId: notification.sourceSignalId,
        type: notification.type,
        isFill: notification.isFill,
        title: notification.title,
        body: notification.body,
        read: notification.read,
        readAt: notification.readAt,
        createdAt: notification.createdAt,
    };
}

function createAlertRoutes({
    LiveStrategyRuntime,
    AlertConfiguration,
    Notification,
    requireAuth,
    validateObjectId,
    createAlertConfiguration,
    updateAlertConfiguration,
    archiveAlertConfiguration,
}) {
    const router = express.Router();

    // --- Alert configurations ---

    router.post("/v2/alert-configurations", requireAuth, async (req, res) => {
        try {
            const { runtimeId, eventTypes, enabled } = req.body;

            if (!runtimeId || typeof runtimeId !== "string") {
                return res.status(400).json({ message: "runtimeId is required" });
            }

            const config = await createAlertConfiguration({
                models: { LiveStrategyRuntime, AlertConfiguration },
                userId: req.user.mongoId,
                runtimeId,
                eventTypes,
                enabled,
            });

            return res.status(201).json({ configuration: configSummary(config) });
        } catch (error) {
            if (error.statusCode) {
                return res.status(error.statusCode).json({ message: error.clientMessage || error.message });
            }
            console.error("Create alert configuration error:", error);
            return res.status(500).json({ message: "Failed to create alert configuration" });
        }
    });

    router.get("/v2/alert-configurations", requireAuth, async (req, res) => {
        try {
            const { page, limit, skip } = parsePagination(req.query);
            const filter = { userId: req.user.mongoId };
            if (req.query.status === "ACTIVE" || req.query.status === "ARCHIVED") {
                filter.status = req.query.status;
            }
            // Workstream L: lets the frontend ask "is there already a
            // configuration for this specific runtime" in one query instead
            // of paginating through every configuration client-side — same
            // optional-query-filter shape as `status` above. An invalid id
            // is silently ignored (matches `status`'s own lenient handling
            // of an unrecognized value) rather than rejected, since this is
            // a read-only convenience filter, not a mutating input.
            if (req.query.runtimeId && mongoose.Types.ObjectId.isValid(req.query.runtimeId)) {
                filter.runtimeId = req.query.runtimeId;
            }

            const [items, total] = await Promise.all([
                AlertConfiguration.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
                AlertConfiguration.countDocuments(filter),
            ]);

            return res.json({ items: items.map(configSummary), page, limit, total });
        } catch (error) {
            console.error("List alert configurations error:", error);
            return res.status(500).json({ message: "Failed to list alert configurations" });
        }
    });

    router.put("/v2/alert-configurations/:configId", requireAuth, validateObjectId("configId"), async (req, res) => {
        try {
            const { enabled, eventTypes } = req.body;
            const config = await updateAlertConfiguration({
                models: { AlertConfiguration },
                userId: req.user.mongoId,
                configId: req.params.configId,
                updates: { enabled, eventTypes },
            });
            return res.json({ configuration: configSummary(config) });
        } catch (error) {
            if (error.statusCode) {
                return res.status(error.statusCode).json({ message: error.clientMessage || error.message });
            }
            console.error("Update alert configuration error:", error);
            return res.status(500).json({ message: "Failed to update alert configuration" });
        }
    });

    router.delete("/v2/alert-configurations/:configId", requireAuth, validateObjectId("configId"), async (req, res) => {
        try {
            const config = await archiveAlertConfiguration({
                models: { AlertConfiguration },
                userId: req.user.mongoId,
                configId: req.params.configId,
            });
            return res.json({ configuration: configSummary(config) });
        } catch (error) {
            if (error.statusCode) {
                return res.status(error.statusCode).json({ message: error.clientMessage || error.message });
            }
            console.error("Archive alert configuration error:", error);
            return res.status(500).json({ message: "Failed to archive alert configuration" });
        }
    });

    // --- Notifications ---

    router.get("/v2/notifications", requireAuth, async (req, res) => {
        try {
            const { page, limit, skip } = parsePagination(req.query);
            const filter = { userId: req.user.mongoId };
            if (req.query.read === "true") filter.read = true;
            if (req.query.read === "false") filter.read = false;

            const [items, total] = await Promise.all([
                Notification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
                Notification.countDocuments(filter),
            ]);

            return res.json({ items: items.map(notificationSummary), page, limit, total });
        } catch (error) {
            console.error("List notifications error:", error);
            return res.status(500).json({ message: "Failed to list notifications" });
        }
    });

    router.get("/v2/notifications/unread-count", requireAuth, async (req, res) => {
        try {
            const count = await Notification.countDocuments({ userId: req.user.mongoId, read: false });
            return res.json({ count });
        } catch (error) {
            console.error("Unread notification count error:", error);
            return res.status(500).json({ message: "Failed to fetch unread count" });
        }
    });

    router.put("/v2/notifications/:notificationId/read", requireAuth, validateObjectId("notificationId"), async (req, res) => {
        try {
            const notification = await Notification.findOneAndUpdate(
                { _id: req.params.notificationId, userId: req.user.mongoId },
                { $set: { read: true, readAt: new Date() } },
                { returnDocument: "after" },
            );
            if (!notification) {
                return res.status(404).json({ message: "Notification not found" });
            }
            return res.json({ notification: notificationSummary(notification) });
        } catch (error) {
            console.error("Mark notification read error:", error);
            return res.status(500).json({ message: "Failed to update notification" });
        }
    });

    router.post("/v2/notifications/mark-all-read", requireAuth, async (req, res) => {
        try {
            const result = await Notification.updateMany(
                { userId: req.user.mongoId, read: false },
                { $set: { read: true, readAt: new Date() } },
            );
            return res.json({ updated: result.modifiedCount ?? result.nModified ?? 0 });
        } catch (error) {
            console.error("Mark all notifications read error:", error);
            return res.status(500).json({ message: "Failed to update notifications" });
        }
    });

    return router;
}

module.exports = { createAlertRoutes };
