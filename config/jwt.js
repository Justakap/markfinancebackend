function getJwtSecret() {
    if (!process.env.JWT_SECRET) {
        throw new Error("JWT_SECRET missing");
    }

    return process.env.JWT_SECRET;
}

module.exports = { getJwtSecret };
