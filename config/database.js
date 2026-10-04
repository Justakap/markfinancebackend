const mongoose = require("mongoose");

function getMongoUri() {
    const uri = process.env.MONGO_URI?.trim();

    if (!uri) {
        throw new Error(
            "MONGO_URI is missing. Add it to backend/.env (see backend/.env.example).",
        );
    }

    return uri;
}

async function connectDatabase() {
    const uri = getMongoUri();

    mongoose.set("strictQuery", true);

    await mongoose.connect(uri, {
        serverSelectionTimeoutMS: 15000,
        connectTimeoutMS: 15000,
        maxPoolSize: 10,
    });

    console.log("MongoDB Connected");
}

function isDatabaseConnected() {
    return mongoose.connection.readyState === 1;
}

async function disconnectDatabase() {
    if (mongoose.connection.readyState === 0) return;
    await mongoose.disconnect();
}

function requireDatabase(req, res, next) {
    if (!isDatabaseConnected()) {
        return res.status(503).json({
            message:
                "Database is not connected. Check MONGO_URI and that MongoDB is reachable.",
        });
    }

    return next();
}

module.exports = {
    connectDatabase,
    disconnectDatabase,
    isDatabaseConnected,
    requireDatabase,
    getMongoUri,
};
