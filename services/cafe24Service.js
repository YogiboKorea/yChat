const dayjs = require('dayjs');
const { getDB } = require("../config/db");
const { apiRequest } = require("../config/cafe24Api");

const { CAFE24_MALLID } = process.env;

let yogiboProducts = [];

async function fetchProductsFromCafe24() {
  try {
    console.log("🟡 Cafe24에서 추천 상품 데이터를 동기화하는 중...");
    const response = await apiRequest("GET", `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products`, {}, {
      display: "T", selling: "T", limit: 100 
    });

    if (response && response.products) {
      yogiboProducts = response.products
        .filter(prod => {
            const name = prod.product_name;
            return !name.includes("메이트") && 
                   !name.includes("[협력사]") &&
                   !name.includes("[한정수량]") &&
                   !name.includes("[공동구매]") &&
                   !name.includes("[리퍼]");
        })
        .map(prod => {
        let category = "소파";
        if (prod.product_name.includes("서포트") || prod.product_name.includes("롤") || prod.product_name.includes("쿠션")) {
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

async function syncCafe24Orders() {
  console.log("🔄 [매출 스케줄러] Cafe24 온라인 매출 집계를 시작합니다...");
  const db = getDB();

  try {
    let currentStart = dayjs('2025-11-01');
    const finalEnd = dayjs(); 
    let totalFetched = 0;

    while (currentStart.isBefore(finalEnd) || currentStart.isSame(finalEnd, 'day')) {
      let currentEnd = currentStart.add(2, 'month').endOf('month'); 
      if (currentEnd.isAfter(finalEnd)) {
        currentEnd = finalEnd;
      }

      const params = {
        shop_no: 1,
        order_status: 'N40', 
        start_date: currentStart.format('YYYY-MM-DD'),
        end_date: currentEnd.format('YYYY-MM-DD'),
        limit: 100,
        offset: 0
      };

      console.log(`📡 [매출 스케줄러] 데이터 요청 구간: ${params.start_date} ~ ${params.end_date}`);

      const response = await apiRequest("GET", `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`, {}, params);
      
      if (response && response.orders && response.orders.length > 0) {
        totalFetched += response.orders.length;
        
        for (const order of response.orders) {
            await db.collection("cafe24Orders").updateOne(
                { order_id: order.order_id },
                { $set: { ...order, updatedAt: new Date() } },
                { upsert: true }
            );
        }
      }
      currentStart = currentEnd.add(1, 'day');
    }
    
    console.log(`✅ [매출 스케줄러] 총 ${totalFetched}건의 주문 데이터를 성공적으로 동기화했습니다.`);
  } catch (error) {
    console.error("❌ [매출 스케줄러] 오류 발생:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
  }
}

async function getOrderShippingInfo(memberId) {
  const today = new Date(); 
  const start = new Date(); 
  start.setDate(today.getDate() - 14);
  return apiRequest("GET", `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`, {}, {
    member_id: memberId, 
    start_date: start.toISOString().split('T')[0], 
    end_date: today.toISOString().split('T')[0], 
    limit: 10
  });
}

async function getShipmentDetail(orderId) {
  const API_URL = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders/${orderId}/shipments`;
  try {
    const response = await apiRequest("GET", API_URL, {}, { shop_no: 1 });
    if (response.shipments && response.shipments.length > 0) {
      const shipment = response.shipments[0];
      const carrierMap = { "0019": { name: "롯데 택배" }, "0039": { name: "경동 택배" }, "0023": { name: "경동 택배" } };
      const carrierInfo = carrierMap[shipment.shipping_company_code] || { name: shipment.shipping_company_name || "지정 택배사" };
      shipment.shipping_company_name = carrierInfo.name;
      return shipment;
    } 
    return null;
  } catch (error) { 
      throw error; 
  }
}

async function getMemberPurchaseHistory(memberId) {
    if (!memberId || memberId === "null") return null;
    try {
        const today = new Date();
        const twoMonthsAgo = new Date();
        twoMonthsAgo.setMonth(today.getMonth() - 2); 

        const response = await apiRequest("GET", `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`, {}, {
            member_id: memberId, start_date: twoMonthsAgo.toISOString().split('T')[0], end_date: today.toISOString().split('T')[0], limit: 20, embed: "items" 
        });

        if (!response.orders) return null;

        const history = { categories: [], products: [], colors: [] };
        response.orders.forEach(order => {
            order.items.forEach(item => {
                history.products.push(item.product_name);
                if (item.product_name.includes("맥스") || item.product_name.includes("미디") || item.product_name.includes("빈백")) history.categories.push("sofa");
                if (item.product_name.includes("서포트") || item.product_name.includes("롤")) history.categories.push("accessory");
                if (item.option_value) history.colors.push(item.option_value); 
            });
        });
        return history;
    } catch (e) {
        console.error("구매이력 조회 실패:", e.message); return null;
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
