const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
    const auth = req.headers.authorization || req.headers.Authorization;

    if (!auth || !auth.startsWith("Bearer ")) {
        return res.status(401).json({ message: "Unauthorized" });
    }

    const token = auth.split(" ")[1];

    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET || "dev-secret");

        req.user = payload;

        return next();
    } catch (err) {
        return res.status(401).json({ message: "Invalid token" });
    }
}

module.exports = { requireAuth };
