const axios = require("axios");
const { getDB } = require("./db");

const { ACCESS_TOKEN, REFRESH_TOKEN, CAFE24_MALLID, CAFE24_API_VERSION = "2025-12-01" } = process.env;

let accessToken = ACCESS_TOKEN;
let refreshToken = REFRESH_TOKEN;
const tokenCollectionName = "tokens";

async function getTokensFromDB() {
  const db = getDB();
  const doc = await db.collection(tokenCollectionName).findOne({});
  if (doc) { 
      accessToken = doc.accessToken; 
      refreshToken = doc.refreshToken; 
  } else { 
      await saveTokensToDB(accessToken, refreshToken); 
  }
}

async function saveTokensToDB(at, rt) {
  const db = getDB();
  await db.collection(tokenCollectionName).updateOne(
      {}, 
      { $set: { accessToken: at, refreshToken: rt, updatedAt: new Date() } }, 
      { upsert: true }
  );
}

// Token refresh uses the DB method as designed in original code
async function refreshAccessToken() { 
    await getTokensFromDB(); 
    return accessToken; 
}

async function apiRequest(method, url, data = {}, params = {}) {
    try {
      const res = await axios({ 
          method, 
          url, 
          data, 
          params, 
          headers: { 
              Authorization: `Bearer ${accessToken}`, 
              'Content-Type': 'application/json', 
              'X-Cafe24-Api-Version': CAFE24_API_VERSION 
          } 
      });
      return res.data;
    } catch (error) {
      if (error.response?.status === 401) { 
          await refreshAccessToken(); 
          return apiRequest(method, url, data, params); 
      }
      throw error;
    }
}

module.exports = {
    getTokensFromDB,
    saveTokensToDB,
    apiRequest,
    CAFE24_MALLID
};
