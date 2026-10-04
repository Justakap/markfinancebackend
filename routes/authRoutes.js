const express = require("express");
const jwt = require("jsonwebtoken");

function createAuthRoutes({ User, Watchlist, getJwtSecret, authLimiter }) {
    const router = express.Router();

    // google login
    router.post("/auth/google", authLimiter, async (req, res) => {
        try {
            const { uid, name, email, photoURL } = req.body;

            if (typeof uid !== "string" || typeof email !== "string" || !uid || !email) {
                return res.status(400).json({
                    success: false,
                    message: "Google uid and email are required",
                });
            }

            if (name != null && typeof name !== "string") {
                return res.status(400).json({ success: false, message: "Invalid name" });
            }

            if (photoURL != null && typeof photoURL !== "string") {
                return res.status(400).json({ success: false, message: "Invalid photoURL" });
            }

            let user = await User.findOne({
                $or: [{ googleId: uid }, { email }],
            });

            let isNewUser = false;

            if (!user) {
                user = await User.create({
                    googleId: uid,
                    name,
                    email,
                    profilePic: photoURL || "",
                });

                isNewUser = true;
            } else {
                user.googleId = user.googleId || uid;
                user.name = name || user.name;
                user.email = email || user.email;
                user.profilePic = photoURL || user.profilePic || "";

                await user.save();
            }

            if (isNewUser) {
                const existingWatchlist = await Watchlist.findOne({
                    userId: user._id,
                });

                if (!existingWatchlist) {
                    await Watchlist.create({
                        name: "My Watchlist",
                        userId: user._id,
                        stocks: [],
                    });
                }
            }

            const token = jwt.sign(
                {
                    mongoId: String(user._id),
                    name: user.name,
                    email: user.email,
                },
                getJwtSecret(),
                { expiresIn: "7d" },
            );

            res.json({
                success: true,
                user,
                token,
            });
        } catch (error) {
            console.error("Google auth error:", error);
            res.status(500).json({
                success: false,
                message: "Authentication failed",
            });
        }
    });

    return router;
}

module.exports = { createAuthRoutes };
