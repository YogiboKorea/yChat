// 상태 코드와 문구 매핑 객체 정의
const orderStatusMap = {
    "N00": "입금전",
    "N10": "상품준비중",
    "N20": "배송준비중",
    "N21": "배송대기",
    "N22": "배송보류",
    "N30": "배송중",
    "N40": "배송완료",
    "N50": "구매확정",
    "C00": "취소신청",
    "C10": "취소접수 - 관리자",
    "C11": "취소접수거부 - 관리자",
    "C34": "취소처리중 - 환불전",
    "C35": "취소처리중 - 환불완료",
    "C36": "취소처리중 - 환불보류",
    "C40": "취소완료",
    "C41": "취소 완료 - 환불전",
    "C42": "취소 완료 - 환불요청중",
    "C43": "취소 완료 - 환불보류",
    "C47": "입금전취소 - 구매자",
    "C48": "입금전취소 - 자동취소",
    "C49": "입금전취소 - 관리자",
    "R00": "반품신청",
    "R10": "반품접수",
    "R11": "반품 접수 거부",
    "R12": "반품보류",
    "R13": "반품접수 - 수거완료(자동)",
    "R20": "반품 수거 완료",
    "R30": "반품처리중 - 수거전",
    "R31": "반품처리중 - 수거완료",
    "R34": "반품처리중 - 환불전",
    "R36": "반품처리중 - 환불보류",
    "R40": "반품완료 - 환불완료",
    "R41": "반품완료 - 환불전",
    "R42": "반품완료 - 환불요청중",
    "R43": "반품완료 - 환불보류",
    "E00": "교환신청",
    "E10": "교환접수",
    "N01": "교환접수 - 교환상품",
    "N02": "입금전 - 카드결제대기",
    "N03": "교환접수 - 카드결제대기",
    "E11": "교환접수거부",
    "E12": "교환보류",
    "E13": "교환접수 - 수거완료(자동)",
    "E20": "교환준비",
    "E30": "교환처리중 - 수거전",
    "E31": "교환처리중 - 수거완료",
    "E32": "교환처리중 - 입금전",
    "E33": "교환처리중 - 입금완료",
    "E34": "교환처리중 - 환불전",
    "E35": "교환처리중 - 환불완료",
    "E36": "교환처리중 - 환불보류",
    "E40": "교환완료",
  };
  
  async function getShipmentDetail(orderId) {
    const API_URL = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders/${orderId}/shipments`;
    const params = { shop_no: 1 };
    try {
      const response = await apiRequest("GET", API_URL, {}, params);
      if (response.shipments && response.shipments.length > 0) {
        const shipment = response.shipments[0];
        // 택배사 코드 매핑
        if (shipment.shipping_company_code === "0019") {
          shipment.shipping_company_name = "롯데 택배";
        } else {
          shipment.shipping_company_name = shipment.shipping_company_code || "정보 없음";
        }
        return shipment;
      } else {
        throw new Error("배송 정보를 찾을 수 없습니다.");
      }
    } catch (error) {
      console.error("Error fetching shipment detail:", error.message);
      throw error;
    }
  }
  
  // 주문번호가 포함된 경우의 처리
  if (containsOrderNumber(normalizedUserInput)) {
    if (memberId && memberId !== "null") {
      try {
        const match = normalizedUserInput.match(/\d{8}-\d{7}/);
        const targetOrderNumber = match ? match[0] : "";
        const shipment = await getShipmentDetail(targetOrderNumber);
        if (shipment) {
          // shipment.status 값에 따라 문구 매핑 (없으면 기본 shipment.status 또는 "정보 없음")
          const statusText = orderStatusMap[shipment.status] || shipment.status || "정보 없음";
          const trackingNo = shipment.tracking_no || "정보 없음";
          const shippingCompany = shipment.shipping_company_name || "정보 없음";
          return {
            text: `주문번호 ${targetOrderNumber}의 배송 상태는 ${statusText}이며, 송장번호는 ${trackingNo}, 택배사는 ${shippingCompany} 입니다.`,
            videoHtml: null,
            description: null,
            imageUrl: null,
          };
        } else {
          return {
            text: "해당 주문번호에 대한 배송 정보를 찾을 수 없습니다.",
            videoHtml: null,
            description: null,
            imageUrl: null,
          };
        }
      } catch (error) {
        return {
          text: "배송 정보를 확인하는 데 오류가 발생했습니다.",
          videoHtml: null,
          description: null,
          imageUrl: null,
        };
      }
    } else {
      return { text: "회원 정보가 확인되지 않습니다. 로그인 후 다시 시도해주세요." };
    }
  }
  
  // 주문번호 없이 주문상태 확인인 경우의 처리
  if (
    (normalizedUserInput.includes("주문상태 확인") ||
      normalizedUserInput.includes("배송 상태 확인") ||
      normalizedUserInput.includes("상품 배송정보") ||
      normalizedUserInput.includes("배송상태 확인") ||
      normalizedUserInput.includes("주문정보 확인") ||
      normalizedUserInput.includes("배송정보 확인")) &&
    !containsOrderNumber(normalizedUserInput)
  ) {
    if (memberId && memberId !== "null") {
      try {
        const orderData = await getOrderShippingInfo(memberId);
        if (orderData.orders && orderData.orders.length > 0) {
          const targetOrder = orderData.orders[0];
          const shipment = await getShipmentDetail(targetOrder.order_id);
          if (shipment) {
            const statusText = orderStatusMap[shipment.status] || shipment.status || "정보 없음";
            const trackingNo = shipment.tracking_no || "정보 없음";
            const shippingCompany = shipment.shipping_company_name || "정보 없음";
            return {
              text: `고객님이 주문하신 상품의 경우 ${shippingCompany}를 통해 ${statusText} 되었으며, 운송장 번호는 ${trackingNo} 입니다.`,
              videoHtml: null,
              description: null,
              imageUrl: null,
            };
          } else {
            return { text: "해당 주문에 대한 배송 상세 정보를 찾을 수 없습니다." };
          }
        } else {
          return { text: "고객님의 주문 정보가 없습니다." };
        }
      } catch (error) {
        return { text: "고객님의 주문 정보를 찾을 수 없습니다. 주문 여부를 확인해주세요." };
      }
    } else {
      return { text: "회원 정보가 확인되지 않습니다. 로그인 후 다시 시도해주세요." };
    }
  }
  