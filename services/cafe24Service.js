const dayjs = require('dayjs');
const { getDB } = require("../config/db");
const { apiRequest } = require("../config/cafe24Api");

let yogiboProducts = [];

// ★ [쿨타임] 회원별 마지막 동기화 시각 캐시 (30분 내 재동기화 방지)
const syncCooldownMap = new Map();

async function fetchProductsFromCafe24() {
  try {
    const CAFE24_MALLID = process.env.CAFE24_MALLID;
    console.log("🟡 Cafe24에서 추천 상품 데이터를 동기화하는 중...");
    const response = await apiRequest("GET", `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products`, {}, {
      display: "T", selling: "T", limit: 100 
    });

    if (typeof response === 'string' && response.includes("<html")) {
        console.error("❌ Cafe24 상품 데이터 동기화 실패: Cafe24 서버 접속 지연 (HTML 응답 수신)");
        return;
    }

    if (response && response.products) {
      // ★ [항목8 개선] 카테고리 ID를 .env에서 읽기 (하드코딩 제거)
      const CAT_MATE     = process.env.CAFE24_CAT_MATE     || "901";
      const CAT_BODYPILLOW = process.env.CAFE24_CAT_BODYPILLOW || "876";
      const CAT_SOFA     = process.env.CAFE24_CAT_SOFA     || "858";

      yogiboProducts = response.products
        .filter(prod => {
            const name = prod.product_name;
            // '메이트'는 10만원 미만 추천용이므로 제외 목록에서 삭제. 수기결제 상품 차단 추가.
            const excludeRegex = /(한정수량|공동구매|리퍼|협력사|LAST CHANCE|사은품|고객결제|개인결제|수기결제|배송비)/i;
            return !name.trim().startsWith('[') && !excludeRegex.test(name);
        })
        .map(prod => {
          let category = "기타";
          if (prod.category) {
              const catArr = Array.isArray(prod.category) ? prod.category : [prod.category];
              const catStr = JSON.stringify(catArr);
              if (catStr.includes(CAT_MATE)) {
                  category = "메이트/캐릭터";
              } else if (catStr.includes(CAT_BODYPILLOW)) {
                  category = "바디필로우";
              } else if (catStr.includes(CAT_SOFA)) {
                  category = "소파";
              } 
          } 
          
          if (prod.product_name.includes("스퀴지보") || prod.product_name.includes("메이트")) {
              category = "메이트/캐릭터";
          } else if (prod.product_name.includes("필로우") || prod.product_name.includes("바디필로우")) {
              category = "바디필로우";
          } else if (prod.product_name.includes("서포트") || prod.product_name.includes("롤") || prod.product_name.includes("쿠션") || prod.product_name.includes("커버")) {
              category = "악세서리";
          }
          
          const rawDescription = prod.summary_description || prod.simple_description || "";
          const keywords = rawDescription.split(",").map(k => k.trim()).filter(k => k);

          return {
            id: prod.product_code || prod.product_no.toString(),
            name: prod.product_name,
            category: category,
            price: parseInt(prod.price || 0),
            features: keywords.length > 0 ? keywords : ["편안함", "빈백"],
            useCase: keywords.length > 0 ? keywords : ["휴식", "인테리어"],
            productUrl: `https://yogibo.kr/product/detail.html?product_no=${prod.product_no}`
          };
        });
      console.log(`✅ [상품 동기화 완료] Cafe24에서 총 ${yogiboProducts.length}개의 상품 캐싱 완료.`);
    }
  } catch (error) {
    console.error("❌ Cafe24 상품 데이터 동기화 실패:", error.message);
  }
}

function getCachedProducts() {
    return yogiboProducts;
}

// ★ [항목4 개선] 6개월 → 1개월 + 30분 쿨타임 적용 (매 대화마다 API 호출 방지)
async function syncCafe24Orders(memberId = null) {
  if (!memberId) return;

  // 30분 쿨타임: 마지막 동기화로부터 30분 미경과 시 스킵
  const lastSync = syncCooldownMap.get(memberId);
  if (lastSync && dayjs().diff(lastSync, 'minute') < 30) {
      console.log(`⏭️ [동기화 스킵] 회원(${memberId}) - 마지막 동기화 후 30분 미경과`);
      return;
  }

  console.log(`🔄 [데이터 동기화] 회원(${memberId}) 최근 1개월 주문 동기화 중...`);
  const db = getDB();
  try {
    const today = dayjs();
    const oneMonthAgo = today.subtract(1, 'month');
    const params = {
      shop_no: 1,
      member_id: memberId,
      start_date: oneMonthAgo.format('YYYY-MM-DD'),
      end_date: today.format('YYYY-MM-DD'),
      limit: 100,
      embed: "items"
    };
    const response = await apiRequest("GET", `https://${process.env.CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`, {}, params);
    if (response && response.orders && response.orders.length > 0) {
      for (const order of response.orders) {
        await db.collection("cafe24Orders").updateOne(
          { order_id: order.order_id },
          { $set: { ...order, member_id: memberId, updatedAt: new Date() } },
          { upsert: true }
        );
      }
      console.log(`✅ [동기화 완료] 회원(${memberId}) ${response.orders.length}건 갱신`);
    }
    // 쿨타임 갱신
    syncCooldownMap.set(memberId, dayjs());
  } catch (error) {
    if (error.response && typeof error.response.data === 'string' && error.response.data.includes('<html')) {
      console.error(`❌ [동기화 실패] Cafe24 서버 접속 지연 (503)`);
    } else {
      console.error("❌ [동기화 실패]:", error.response ? JSON.stringify(error.response.data) : error.message);
    }
  }
}

async function getOrderShippingInfo(memberId) {
  const today = new Date(); 
  const start = new Date(); 
  start.setDate(today.getDate() - 14);
  return apiRequest("GET", `https://${process.env.CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`, {}, {
    member_id: memberId, 
    start_date: start.toISOString().split('T')[0], 
    end_date: today.toISOString().split('T')[0], 
    limit: 10
  });
}

async function getShipmentDetail(orderId) {
  const API_URL = `https://${process.env.CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders/${orderId}/shipments`;
  try {
    const response = await apiRequest("GET", API_URL, {}, { shop_no: 1 });
    if (response.shipments && response.shipments.length > 0) {
      const shipment = response.shipments[0];
      const carrierMap = { 
          "0019": { name: "롯데 택배", url: "https://www.lotteglogis.com/" }, 
          "0039": { name: "경동 택배", url: "https://kdexp.com/index.do" }, 
          "0023": { name: "경동 택배", url: "https://kdexp.com/index.do" } 
      };
      
      const carrierInfo = carrierMap[shipment.shipping_company_code] || { name: shipment.shipping_company_name || "지정 택배사", url: "" };
      shipment.shipping_company_name = carrierInfo.name;
      
      if (!shipment.tracking_url || shipment.tracking_url === "undefined") {
          if (carrierInfo.url && shipment.tracking_no) {
              shipment.tracking_url = carrierInfo.url.endsWith("=") ? carrierInfo.url + shipment.tracking_no : carrierInfo.url;
          } else if (shipment.tracking_no) {
              shipment.tracking_url = `https://search.naver.com/search.naver?query=${encodeURIComponent(shipment.shipping_company_name + ' 배송조회 ' + shipment.tracking_no)}`;
          } else {
              shipment.tracking_url = "#";
          }
      }
      return shipment;
    } 
    return null;
  } catch (error) { 
      throw error; 
  }
}

// ★ [항목5 개선] Cafe24 API 직접 호출 → DB(cafe24Orders)에서 읽기로 전환 (응답 속도 대폭 향상)
async function getMemberPurchaseHistory(memberId) {
    if (!memberId || memberId === "null") return null;
    try {
        const db = getDB();
        const oneMonthAgo = dayjs().subtract(1, 'month').toDate();
        // DB에서 최근 1개월 주문 조회 (syncCafe24Orders가 미리 저장해 놓음)
        const orders = await db.collection("cafe24Orders").find({
            member_id: memberId,
            updatedAt: { $gte: oneMonthAgo }
        }).toArray();

        const history = { categories: [], products: [], colors: [] };
        orders.forEach(order => {
            const items = order.items || [];
            items.forEach(item => {
                if (!history.products.includes(item.product_name)) history.products.push(item.product_name);
                if (item.product_name.includes("맥스") || item.product_name.includes("미디") || item.product_name.includes("빈백")) history.categories.push("sofa");
                if (item.product_name.includes("서포트") || item.product_name.includes("롤")) history.categories.push("accessory");
                if (item.option_value) history.colors.push(item.option_value);
            });
        });

        return history.products.length > 0 ? history : null;
    } catch (e) {
        console.error("구매이력 DB 조회 실패:", e.message); return null;
    }
}

module.exports = {
    fetchProductsFromCafe24,
    getCachedProducts,
    syncCafe24Orders,
    getOrderShippingInfo,
    getShipmentDetail,
    getMemberPurchaseHistory
};
