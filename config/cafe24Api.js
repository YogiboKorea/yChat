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

// 실제 Cafe24 OAuth 토큰 갱신 호출
async function refreshAccessToken() { 
    try {
        const url = `https://${process.env.CAFE24_MALLID}.cafe24api.com/api/v2/oauth/token`;
        const clientId = process.env.CAFE24_CLIENT_ID;
        const clientSecret = process.env.CAFE24_CLIENT_SECRET;
        
        if (!clientId || !clientSecret) {
             throw new Error("CAFE24_CLIENT_ID 또는 CAFE24_CLIENT_SECRET이 없습니다.");
        }

        const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
        const payload = new URLSearchParams();
        payload.append('grant_type', 'refresh_token');
        payload.append('refresh_token', refreshToken);

        console.log("🔄 토큰 만료(401) 감지. 새로운 Access Token을 발급받습니다...");
        const res = await axios.post(url, payload.toString(), {
            headers: {
                'Authorization': `Basic ${authHeader}`,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        accessToken = res.data.access_token;
        refreshToken = res.data.refresh_token; // 리프레시 토큰도 함께 갱신될 수 있음
        
        await saveTokensToDB(accessToken, refreshToken);
        console.log("✅ Cafe24 Access Token 갱신 성공");
        return accessToken;
    } catch (e) {
        console.error("❌ Cafe24 Token 갱신 실패:", e.response?.data || e.message);
        throw new Error("Token refresh failed");
    }
}

// isRetry 플래그를 추가하여 무한루프 방지
async function apiRequest(method, url, data = {}, params = {}, isRetry = false) {
    // 처음 요청 전에 DB에서 캐싱된 최신 토큰을 읽어봄 (멀티 프로세스/pm2 환경 대비)
    if (!isRetry) await getTokensFromDB();
    
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
      // 401 권한 에러이고 재시도가 아닌 경우 딱 한 번만 토큰 갱신 후 재진입
      if (error.response && error.response.status === 401 && !isRetry) { 
          await refreshAccessToken(); 
          return apiRequest(method, url, data, params, true); 
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
