const { MongoClient } = require("mongodb");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

const { MONGODB_URI, DB_NAME } = process.env;

let client;
let db;

async function connectDB() {
    if (client && db) {
        return db;
    }
    try {
        client = new MongoClient(MONGODB_URI);
        await client.connect();
        db = client.db(DB_NAME);
        console.log("✅ MongoDB Connection Pool Initialized");
        return db;
    } catch (error) {
        console.error("❌ MongoDB Connection Error:", error);
        process.exit(1);
    }
}

function getDB() {
    if (!db) {
        throw new Error("🚨 DB가 연결되지 않았습니다. connectDB()를 먼저 호출하세요.");
    }
    return db;
}

module.exports = { connectDB, getDB, client };
