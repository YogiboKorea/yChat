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

// 진행 중인 갱신 Promise (동시 갱신 stampede 방지용 뮤텍스)
let refreshPromise = null;

// 실제 Cafe24 OAuth 토큰 갱신 호출
// ⚠ cafe24 refresh_token 은 1회용(rotation)이라, 다수 요청이 동시에 401 을 받고
//   동시에 갱신을 시도하면 첫 1개만 성공하고 나머지는 invalid_grant 로 실패한다.
//   → 진행 중인 갱신이 있으면 같은 Promise 를 공유해 "단 한 번만" 갱신한다.
//   reason: 로그용(기본 '401 감지'). tokenKeepalive 의 선제 갱신은 '선제 갱신…' 을 넘긴다.
async function refreshAccessToken(reason = '401 감지') {
    if (refreshPromise) return refreshPromise;

    refreshPromise = (async () => {
        try {
            const url = `https://${process.env.CAFE24_MALLID}.cafe24api.com/api/v2/oauth/token`;
            const clientId = process.env.CAFE24_CLIENT_ID;
            const clientSecret = process.env.CAFE24_CLIENT_SECRET;

            if (!clientId || !clientSecret) {
                 throw new Error("CAFE24_CLIENT_ID 또는 CAFE24_CLIENT_SECRET이 없습니다.");
            }

            // 갱신 직전 DB 의 최신 refresh_token 을 다시 읽어, 다른 프로세스가 이미
            // 회전시킨 토큰을 덮어쓰지 않도록 한다.
            try { await getTokensFromDB(); } catch (_) { /* DB 실패 시 메모리값 사용 */ }

            const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
            const payload = new URLSearchParams();
            payload.append('grant_type', 'refresh_token');
            payload.append('refresh_token', refreshToken);

            console.log(`🔄 Cafe24 토큰 갱신 (${reason}). 새로운 Access Token 발급…`);
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
        } finally {
            refreshPromise = null;
        }
    })();

    return refreshPromise;
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
    refreshAccessToken,   // tokenKeepalive(선제 갱신 cron) 에서 같은 모듈 인스턴스로 호출 → refreshPromise 뮤텍스 공유
    CAFE24_MALLID
};
