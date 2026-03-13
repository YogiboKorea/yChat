const dayjs = require('dayjs');
const { getDB } = require("../config/db");
const { apiRequest } = require("../config/cafe24Api");

let yogiboProducts = [];

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
      yogiboProducts = response.products
        .filter(prod => {
            const name = prod.product_name;
            // 제외 조건: 
            // 1. 이름이 '[' 로 시작하는 모든 상품 (예: [LAST CHANCE], [리퍼], [협력사] 등)
            // 2. 이름 어딘가에 메이트, 한정수량, 공동구매, 사은품 등이 포함된 상품
            // (혹시 모를 공백 문제를 위해 LAST CHANCE 등도 명시적 차단)
            const excludeRegex = /(메이트|한정수량|공동구매|리퍼|협력사|LAST CHANCE|사은품)/i;
            return !name.trim().startsWith('[') && !excludeRegex.test(name);
        })
        .map(prod => {
        // 카테고리 매핑 (소파 858, 바디필로우 876, 메이트/캐릭터 901)
        let category = "기타";
        if (prod.category) {
            const catArr = Array.isArray(prod.category) ? prod.category : [prod.category];
            const catStr = JSON.stringify(catArr);
            if (catStr.includes("901")) {
                category = "메이트/캐릭터";
            } else if (catStr.includes("876")) {
                category = "바디필로우";
            } else if (catStr.includes("858")) {
                category = "소파";
            } 
        } 
        
        // 카테고리 태그 누락이나 오류를 교정하는 이름 기반 강제 할당
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

// 회원별 주문 데이터를 실시간 또는 필요한 시점에만 동기화하도록 수정 (서버 부하 방지)
async function syncCafe24Orders(memberId = null) {
  if (!memberId) {
      console.log("⚠️ [매출 동기화] memberId가 없어서 동기화를 생략합니다.");
      return;
  }
  
  console.log(`🔄 [데이터 동기화] 회원(${memberId})의 최근 주문 내역을 동기화합니다...`);
  const db = getDB();

  try {
    const today = dayjs();
    const sixMonthsAgo = dayjs().subtract(6, 'month');

    // Cafe24는 한 번 조회 시 너무 긴 기간을 허용하지 않거나(최대 90일),
    // 특정 기준일로부터 6개월 이내만 조회 가능합니다.
    // 안전하게 60일(대략 2달) 단위로 끊어서 조회합니다.
    let currentEnd = today;
    
    while (currentEnd.isAfter(sixMonthsAgo)) {
        let currentStart = currentEnd.subtract(60, 'day');
        if (currentStart.isBefore(sixMonthsAgo)) {
            currentStart = sixMonthsAgo;
        }

        const params = {
          shop_no: 1,
          member_id: memberId,
          start_date: currentStart.format('YYYY-MM-DD'),
          end_date: currentEnd.format('YYYY-MM-DD'),
          limit: 100,
          embed: "items" 
        };

        const response = await apiRequest("GET", `https://${process.env.CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`, {}, params);
        
        if (response && response.orders && response.orders.length > 0) {
          for (const order of response.orders) {
              await db.collection("cafe24Orders").updateOne(
                  { order_id: order.order_id },
                  { $set: { ...order, updatedAt: new Date() } },
                  { upsert: true }
              );
          }
          console.log(`✅ [데이터 동기화] 회원(${memberId})의 ${currentStart.format('MM-DD')}~${currentEnd.format('MM-DD')} 기간 주문 갱신 완료.`);
        }
        
        // 다음 루프를 위해 종료일을 갱신 (currentStart의 하루 전)
        currentEnd = currentStart.subtract(1, 'day');
    }
  } catch (error) {
    if (error.response && typeof error.response.data === 'string' && error.response.data.includes("<html")) {
        console.error(`❌ [매출 스케줄러] Cafe24 서버 접속 지연 (503 Service Unavailable)`);
    } else {
        console.error("❌ [매출 스케줄러] 오류 발생:", error.response ? JSON.stringify(error.response.data, null, 2) : error.message);
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
      
      // Cafe24에서 tracking_url을 제대로 안 내려주거나 undefined인 경우 직접 조립
      if (!shipment.tracking_url || shipment.tracking_url === "undefined") {
          if (carrierInfo.url && shipment.tracking_no) {
              shipment.tracking_url = carrierInfo.url.endsWith("=") ? carrierInfo.url + shipment.tracking_no : carrierInfo.url;
          } else if (shipment.tracking_no) {
              // 매핑되지 않은 택배사는 네이버 검색 연동으로 폴백 처리
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

async function getMemberPurchaseHistory(memberId) {
    if (!memberId || memberId === "null") return null;
    try {
        const history = { categories: [], products: [], colors: [] };
        let currentEnd = dayjs();
        // Cafe24 검색 가능 최대 기간인 6개월 전까지만 조회
        const limitDate = dayjs().subtract(6, 'month');

        while (currentEnd.isAfter(limitDate)) {
            // 한 번에 최대 90일 이내로 끊어서 조회해야 하므로 안전하게 60일씩 차감
            let currentStart = currentEnd.subtract(60, 'day');
            if (currentStart.isBefore(limitDate)) {
                currentStart = limitDate;
            }

            const response = await apiRequest("GET", `https://${process.env.CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`, {}, {
                member_id: memberId, 
                start_date: currentStart.format('YYYY-MM-DD'), 
                end_date: currentEnd.format('YYYY-MM-DD'), 
                limit: 50, 
                embed: "items" 
            });

            if (response && response.orders) {
                response.orders.forEach(order => {
                    order.items.forEach(item => {
                        // 중복 방지를 위해 확인 후 push (선택적)
                        if (!history.products.includes(item.product_name)) history.products.push(item.product_name);
                        
                        if (item.product_name.includes("맥스") || item.product_name.includes("미디") || item.product_name.includes("빈백")) history.categories.push("sofa");
                        if (item.product_name.includes("서포트") || item.product_name.includes("롤")) history.categories.push("accessory");
                        if (item.option_value) history.colors.push(item.option_value); 
                    });
                });
            }

            currentEnd = currentStart.subtract(1, 'day');
        }

        return history.products.length > 0 ? history : null;
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
