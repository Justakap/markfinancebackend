const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
    {
        name: String,

        email: {
            type: String,
            unique: true
        },

        googleId: {
            type: String,
            default: null
        },

        profilePic: {
            type: String,
            default: ""
        }
    },
    {
        timestamps: true
    });

module.exports = mongoose.model("User", userSchema);