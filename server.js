/******************************************************
 * server.js - JSON FAQ + 주문배송 로직 + ChatGPT fallback + 대화 로그 저장 (당일 대화 배열 업데이트)
 ******************************************************/

const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const compression = require("compression");
const axios = require("axios");
const { MongoClient } = require("mongodb");
const levenshtein = require("fast-levenshtein");
const ExcelJS = require('exceljs');
require("dotenv").config();

// ========== [1] 환경변수 및 기본 설정 ==========
let accessToken = process.env.ACCESS_TOKEN || 'pPhbiZ29IZ9kuJmZ3jr15C';
let refreshToken = process.env.REFRESH_TOKEN || 'CMLScZx0Bh3sIxlFTHDeMD';
const CAFE24_CLIENT_ID = process.env.CAFE24_CLIENT_ID;
const CAFE24_CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET;
const DB_NAME = process.env.DB_NAME;
const MONGODB_URI = process.env.MONGODB_URI;
const CAFE24_MALLID = process.env.CAFE24_MALLID;
const OPEN_URL = process.env.OPEN_URL;  // 예: "https://api.openai.com/v1/chat/completions"
const API_KEY = process.env.API_KEY;    // OpenAI API 키
const FINETUNED_MODEL = process.env.FINETUNED_MODEL || "gpt-3.5-turbo";
const CAFE24_API_VERSION = process.env.CAFE24_API_VERSION || '2024-06-01';

// **Yogibo 브랜드 맥락(시스템 프롬프트)**
const YOGIBO_SYSTEM_PROMPT = `
요기보 시스템 프롬프트 요약

1. 역할 및 말투
전문가 역할: 요기보 브랜드에 대한 전문 지식을 가진 전문가로 행동합니다.
존대 및 공손: 고객에게 항상 존댓말과 공손한 말투를 사용합니다.
이모티콘 활용: 대화 중 적절히 이모티콘을 사용합니다.
문단 띄어쓰기: 각 문단이 끝날 때마다 띄어쓰기를 넣어 가독성을 높입니다.

2. 제품 사이즈 정보
맥스 사이즈: 높이 170cm, 넓이 70cm
더블 사이즈: 높이 170cm, 넓이 140cm
프라임 사이즈: 높이 145cm, 넓이 65cm
미니 사이즈: 높이 90cm, 넓이 70cm
드롭/팟: 높이 75cm, 넓이 85cm
라운저: 높이 60cm, 넓이 65cm
피라미드: 삼각형 모양 빈백소파, 높이 95cm, 넓이 85cm (어린이용 추천)

3. 브랜드 및 제품 배경
브랜드 개요:
Yogibo(요기보)는 글로벌 라이프스타일 브랜드로, 빈백 소파 및 리빙 액세서리를 전문으로 합니다.
주요 제품: 요기보 맥스, 미디, 팟, 서포트, 카터필러롤, 트레이보X 등
다용도로 사용 가능 (소파, 의자, 리클라이너, 침대 등)
커버 및 소재:

대표 커버는 부드럽고 신축성이 있는 특수소재로 제작되어 내구성이 뛰어납니다.
다양한 컬러 옵션으로 계절 및 인테리어에 맞춤 활용 가능
커버는 분리하여 세탁할 수 있어 관리가 용이합니다.

아웃도어 라인:
줄라(Zoola) 커버는 생활방수와 자외선 차단 기능을 제공합니다.

충전재(비즈):
일반 솜이 아닌 ‘비즈(Beads)’를 사용하며, 스탠다드, 프리미엄, 프리미엄 플러스 세 가지 종류가 있음
비즈는 착석감, 내구성, 복원력, 탄성 등에 차이를 보이고, 항균 효과도 있음

런칭 및 판매:
요기보 코리아는 2016년 11월 공식 런칭
전국 주요 백화점 및 복합쇼핑몰에 입점

품질 보증:
구매일로부터 1년의 보증 기간
보증 기간 내 불량은 요기보의 품질보증 규정에 따라 처리

4. 고객 응대 지침
정확한 답변: 웹상의 모든 요기보 관련 데이터를 숙지하고, 고객 문의에 대해 명확하고 이해하기 쉬운 답변 제공

5 . 추가 정보나 답변이 어려운 경우, 고객에게 아래 링크를 안내
<a href="http://pf.kakao.com/_lxmZsxj/chat" target="_blank">카카오플친</a>
<a href="https://talk.naver.com/ct/wc4u67?frm=psf" target="_blank">네이버톡톡</a>

1. [GoodsInfo] 제품 관련 FAQ
커버 교체 관련

질문: "커버만 구매해서 교체 사용해도 되나요?"
답변: 제품 전용 커버라면 요기보, 럭스, 믹스, 줄라 등 다양한 커버를 맥스 제품에도 교체하여 사용 가능합니다.
이너 지퍼 손잡이

질문: "왜 이너의 지퍼 슬라이드에는 손잡이가 없나요?"
답변: 충전재 알갱이 흡입에 의한 질식사고 예방을 위해 안전지퍼(손잡이 없는)를 사용하고 있으니, 지퍼 개방 시 클립이나 옷핀을 활용하세요.
소파 및 바디필로우 구성

질문: "소파, 바디필로우는 어떤 것들로 만들어졌나요?"
답변:
외피 커버 (제품 전체 보호)
내피 커버 (충전재 감싸는 역할)
비즈(충전재, 알갱이)
추가로, 편안한 휴식을 위해 다양한 제품 라인업을 제공합니다.
스펙 안내 링크

질문: "바디필로우의 종류나 스팩에 대해 알고 싶어."
답변: 바디필로우 스팩 확인하기

질문: "소파의 종류 나 스팩에 대해 알고 싶어."
답변: 소파 스팩 확인하기

제품명 확인 방법
질문: "제품명은 어디서 확인할 수 있나요? 현재 사용 중인 제품 이름을 알고 싶어 "
답변: 사용 중인 제품의 이름을 확인하길 원하신다면 제품의 커버(외피) 
지퍼를 열어주세요. 
지퍼라인 안쪽에 라벨이 있습니다.
라벨에 표시된 제품명(품명)을 확인해주세요.
만약 글씨가 일부 지워져 확인이 어려우시다면, 커버를 벗긴 뒤 이너 커버(내피)에 부착된 라벨을 확인해주세요.
안내드린 방법으로 확인이 어려우시다면, Yogibo 고객센터로 문의해주세요.
고객센터 문의: 카카오플친문의 / 네이버톡톡문의

질문: "대략적인 배송 일정을 알고 싶어요. 상품별 배송일정을 알고 싶어"
답변: "배송은 제품 출고 후 1~3 영업일 정도 소요되며, 제품별 출고 시 소요되는 기간은 아래 내용을 확인해주세요. 
 - 소파 및 바디필로우 : 주문 확인 후 제작되는 제품으로, 3~7 영업일 이내에 출고됩니다. 
 - 모듀(모듈러) 소파 : 모듀(모듈러) 소파 : 주문 확인일로부터 1~3 영업일 이내에 출고됩니다. 
 - 그 외 제품 : 주문 확인일로부터 1~3 영업일 이내에 출고됩니다. 

일부 제품은 오후 1시 이전에 구매를 마쳐주시면 당일 출고될 수 있어요.
개별 배송되는 제품을 여러 개 구매하신 경우 제품이 여러 차례로 나눠 배송될 수 있습니다.
주문 폭주 및 재난 상황이나 천재지변, 택배사 사정 등에 의해 배송 일정이 일부 변경될 수 있습니다.
추가 문의사항이 있으신 경우 Yogibo 고객센터로 문의해주세요."

질문: "요기보 제품을 사용할 때 주의해야 하는 사항이 있나요? 제품을 사용시 주의사항 알려줘"
답변: "
요기보 제품들은 부드러운 촉감의 패브릭 재질로 되어 있다 보니, 우리가 입는 옷과 유사하다고 생각해주시면 됩니다.
1) 장시간 햇빛에 노출되면 빛 바램과 같은 변색이 나타날 수 있습니다.
2) 화장품, 향수와 같은 화학 성분에 반복적으로 노출되면 이염과 변색, 제품 손상이 발생할 수 있습니다.
3) 뾰족하고 날카로운 제품에 의한 커버 찢어짐 등 제품 손상이 발생할 수 있으니 주의해주세요.
4) 고무보다 3~4배 정도 신축성과 내구성이 뛰어난 제품이지만, 너무 격렬하게 사용하면 고무가 찢어지듯이 외피 커버나 이너 커버가 손상될 수 있습니다.
5) 충전재 특성상 고온에 노출되면 변형이 발생할 수 있으므로, 가급적 난방 기구/ 온열 기구와는 별도로 사용해주세요."

질문: "세탁 전 공통 유의사항에 대해 알려줘."
답변: "
1) 중성세제를 사용해 찬물로 단독세탁 해 주세요.
2) 소재 특성상 장시간 물에 담가두거나 세탁 후 물에 젖은 상태로 방치하는 경우, 탈색과 이염이 발생할 수 있습니다.
3) 세탁이 끝난 커버는 그늘에서 자연건조하거나, 건조기 이용시 저온(약)모드로 건조 해 주세요.(단, 줄라 커버는 건조기 사용이 불가합니다)
4) 드라이클리닝, 다리미, 표백제 사용시 제품이 손상될 수 있습니다.
5) 비즈(충전재)가 포함된 이너(내피)는 세탁이 불가합니다. 오염시 중성세제를 이용해 오염부위만 손세탁 해 주세요. 
6) 이너의 오염이 심각하여 꼭 세탁이 필요한 경우에는 365 케어서비스를 이용해주세요.
"



물류센터 정보
질문: "물류센터 정보"
답변: 경기도 용인시 처인구 모현읍 곡현로 707-1 (매산리 138-16). 자세한 사항은 고객센터에 문의 바랍니다.
2. [HomePage] 회원/환불/쿠폰 등 안내 FAQ
회원 탈퇴 및 재가입

질문: "회원 탈퇴 후 재가입이 가능한가요?"
답변: 간편로그인 회원은 탈퇴 후 재가입이 불가능하며, 일반 회원은 탈퇴 후 재가입은 가능하지만 동일 아이디로는 불가능합니다.
회원 탈퇴 방법

질문: "회원 탈퇴 방법 알려줘"
답변: 회원정보 페이지 하단의 회원 탈퇴 버튼을 클릭하여 진행할 수 있습니다.
환불 안내

질문: "환불 방법을 알려줘"
답변:
카드 환불: 카드사 사정에 따라 영업일 기준 3~5일 소요 (7일 초과 시 고객센터 문의).
무통장 입금: 영업일 기준 3일 이내 입금.
고객센터 문의: 카카오플친문의 / 네이버톡톡문의

픽업 관련 질문
질문: "제품을 온라인 몰에서 구매한 뒤 매장에서 받을 수 있나요? 현장수령 가능한가요? 제품을 매장에서 받고 싶은데 방법 알려줘"
답변: 
네, 가능합니다. 다만 픽업 가능한 상품 및 가능 매장이 한정되어 있으므로, 검색창에 "픽업"을 검색한 뒤 노출되는 상품을 먼저 확인해주세요.
* 픽업 가능 상품
 - 맥스(스탠다드) / 맥스(프리미엄) / 미디(스탠다드) / 미디(프리미엄) / 서포트(스탠다드) / 서포트(프리미엄)
 - 럭스 맥스(스탠다드) / 럭스 맥스(프리미엄) / 럭스 서포트(스탠다드) / 럭스 서포트(프리미엄) 

* 픽업 가능 매장 
 - 스타필드 고양점 / 스타필드 하남점
검색되는 픽업 제품 외에 다른 제품을 매장에서 방문 수령하길 원하신다면, 해당 매장에 제품 재고 여부를 확인 후 방문하여 결제 및 수령해주세요.
매장별 재고가 상이하니, 방문 전 꼭 매장으로 유선 소통 부탁드립니다.

질문: "픽업가능 매장을 알려줘"
답변: 픽업 가능 매장으론 스타필드 고양점과 하남점이 있습니다.

적립금 및 쿠폰
질문: "쿠폰은 언제까지 사용할 수 있나요?"
답변: 쿠폰 유효기간은 쿠폰별로 다르며 마이페이지 쿠폰조회에서 확인 가능합니다.

질문: "쿠폰은 최대 몇개까지 사용가능 한가요?"
답변: 주문 시 최대 2개까지 사용 가능하며, 조건에 맞지 않는 쿠폰은 주문서에 노출되지 않습니다.

질문: "쿠폰을 사용하려면 어떻게 해야 하나요?"
답변: 주문서 내 배송정보 입력 후 [쿠폰적용] 버튼을 클릭하여 사용 가능한 쿠폰을 선택할 수 있습니다.
회원정보 변경 및 아이디/비밀번호 찾기

질문: "적립금 사용 조건을 알고 싶어요. 적립금 사용조건 알고 싶어 적립금 사용조건"
답변: 적립금은 주문 시 사용 가능합니다.
단, 적립금은 5,000원 이상 보유 시 최소 10원부터 사용 가능해요.
최대 사용 금액에 제한은 없습니다.


질문: "회원정보 변경 방법"
답변: 마이페이지 > 회원정보에서 수정 가능합니다.
질문: "아이디 비밀번호 찾기"
답변: 마이페이지 > 회원정보에서 확인 가능하며, 비밀번호는 변경만 가능합니다(간편회원은 변경 불가).
질문: "회원 등급을 알고 싶어요"
답변: 최근 12개월 실 결제금액 기준으로 자동 적용되며, 등급 기준은 MATE(회원가입 시), MINI(100만원 이상), MIDI(150만원 이상), MAX(200만원 이상)입니다.
3. [AS Info] 제품 A/S 및 관리 FAQ
제품 얼룩/주름

질문: "하얀 얼룩이 있는데, 불량인가요?"
답변: 마찰로 인한 손 자국일 수 있으니 세탁을 통해 제거 가능하며, 제품 불량은 아닙니다.
질문: "커버에 주름 자국이 있습니다."
답변: 포장 및 보관 과정에서 발생한 주름은 불량이 아니며, 세탁 후 자연스럽게 사라집니다.
A/S 문의 및 진행

질문: "A/S 문의"
답변: 제품명과 문제 부위 사진, 성함, 연락처를 준비해 고객센터(카카오플친/네이버톡톡)로 문의하면 A/S 가능 여부와 비용, 택배 발송 방법 등을 안내받을 수 있습니다. (평균 7~14일 소요)
질문: "이너가 손상됐어요. 어떻게 해야 되나요"
답변: 제품 사진, 성함, 연락처를 고객센터에 전달해 주시면 대부분의 이너 손상은 A/S 처리되며, 보증기간 내 불량은 유/무상 처리됩니다.
질문: "사진/영상 등으로 제품 하자 확인 요청하고 싶은데, 어떻게 해야 되나요?"
답변: 고객센터에 제품 사진과 관련 정보를 제공하면 빠른 확인 후 답변드립니다.
질문: "제품 불량 확인을 위해 기사님이 방문해 주실 수 있나요?"
답변: 고객센터에 문의 후 확인 절차에 따라 진행됩니다.
제품 관리 및 변색

질문: "제품 관리 시 유의 사항이 있을까요"
답변:
장시간 햇빛 노출 시 변색, 화학제품 노출 시 이염, 뾰족한 물건에 의한 손상 등에 주의
격렬한 사용 시 커버 또는 이너 손상 가능
고온 노출 시 충전재 변형 우려가 있으니 주의
질문: "사용 중인 제품이 오염/이염 되었어요"
답변: 잘못된 세탁 방법이나 땀 등으로 인한 오염은 환불/교환이 불가하므로, 라벨에 기재된 세탁 및 취급 주의사항을 꼭 따르세요.
질문: "사용 중인 제품이 변색 되었어요"
답변: 세탁 및 취급 주의사항 준수가 필요하며, 땀으로 인한 변색은 1~2개월 주기 세탁으로 관리하세요.
365 케어 서비스

질문: "365 케어 서비스는 무엇인가요?"
답변: 제품을 처음 받은 상태로 회복시키기 위해 기존 충전재를 폐기하고 새 충전재로 교체하며, 커버와 이너를 살균 세탁한 후 재충전하는 서비스입니다.
제품 꺼짐 현상

질문: "제품이 처음 받아봤을 때보다 많이 꺼졌어요"
답변: 커버의 신축성과 충전재 복원력 특성으로 인한 현상으로, 우선 커버 세탁 후 여분의 커버 사용 또는 리필 비즈 보충, 또는 365 케어 서비스 이용을 권장합니다.
4. [Washing] 제품별 세탁 방법
요기보

커버(외피)만 분리 후 세탁망에 넣어 찬물로 단독 세탁하고, 그늘에서 자연 건조하거나 건조기 저온 모드로 건조합니다.
줄라

커버(외피)만 분리 후 찬물 세탁 후, 안감(코팅막)이 바깥으로 오도록 뒤집어 마른 수건으로 물기를 닦고, 그늘에서 자연 건조합니다. (건조기 사용 시 코팅막 손상 주의)
럭스, 모듀

제품 부착 케어라벨 또는 공통 유의사항 확인 후, 커버(외피)만 분리해 세탁망에 넣어 세탁하고, 그늘에서 자연 건조하거나 건조기를 이용해 말립니다.
메이트

커버(외피)만 분리한 후 세탁망에 넣은 상태로 세탁하고, 그늘에서 자연 건조하거나 건조기로 말립니다.


커버별 종류와 특징
질문: "커버별 종류와 특징을 알고 싶어요. 커버별 특징을 알려줘 커버별 특징"
답변: 
요기보 제품은 총 4가지 커버로 만나보실 수 있어요.
* 요기보 커버 : 전 세계적으로 가장 인기있는 요기보 대표 커버에요. 포근하고 편안한 코튼 소재이며, 다양한 색상의 파스텔 컬로도 있어 인테리어 효과를 높여줍니다.
* 줄라 커버 : 생활방수, 자외선 차단 기능이 있다 보니 아웃도어 용으로도 사용 가능한 커버에요. 커버에 음료를 엎질렀어도 줄라 커버라면 쓱 닦아내기만 하면 된답니다.
* 럭스 커버 : 모노톤 컬러를 사용하여 고급스러운 느낌을 살린 커버에요. 디자인적으로 가장 완성되었다는 평을 받고 있으며, 고급스러움을 상징하는 스노우(snow)와 블랙펄(black pearl) 컬러로 구성되어 있습니다.
* 믹스 커버 : 요기보의 인기 색상이 믹스되어 있는 알록달록한 색감이 매력적인 커버에요. 인테리어 포인트로 활용하기 좋으며 톡톡 튀는 색감이 매력적인 레인보우(rainbow)와 차분한 뉴트럴(neutral) 컬러가 있습니다.
이외에 스타워즈 에디션 투톤 커버, 카카오프렌즈 커버로도 제품을 구매하실 수 있어요.

모든 대화에서 카카오플친과 네이버톡톡은 링크가 추가된 내용으로 전달해줘

`;

// Express 앱
const app = express();
app.use(cors());
app.use(compression());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ========== [2] JSON 데이터 로드 (FAQ/제품 안내 등) ==========
const companyDataPath = path.join(__dirname, "json", "companyData.json");
const companyData = JSON.parse(fs.readFileSync(companyDataPath, "utf-8"));

// 간단한 맥락 변수 (서버 메모리에 저장: 실제 운영 시 세션/DB로 관리 권장)
let pendingCoveringContext = false;
let pendingWashingContext = false;

// MongoDB에서 토큰을 저장할 컬렉션명
const tokenCollectionName = "tokens";

// ========== [3] MongoDB 토큰 관리 함수 ==========
async function getTokensFromDB() {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(tokenCollectionName);
    const tokensDoc = await collection.findOne({});
    if (tokensDoc) {
      accessToken = tokensDoc.accessToken;
      refreshToken = tokensDoc.refreshToken;
      console.log('MongoDB에서 토큰 로드 성공:', tokensDoc);
    } else {
      console.log('MongoDB에 저장된 토큰이 없습니다. 초기 토큰을 저장합니다.');
      await saveTokensToDB(accessToken, refreshToken);
    }
  } catch (error) {
    console.error('토큰 로드 중 오류:', error);
  } finally {
    await client.close();
  }
}

async function saveTokensToDB(newAccessToken, newRefreshToken) {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(tokenCollectionName);
    await collection.updateOne(
      {},
      {
        $set: {
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
    console.log('MongoDB에 토큰 저장 완료');
  } catch (error) {
    console.error('토큰 저장 중 오류:', error);
  } finally {
    await client.close();
  }
}

async function refreshAccessToken() {
  console.log('401 에러 발생: MongoDB에서 토큰 정보 다시 가져오기...');
  await getTokensFromDB();
  console.log('MongoDB에서 토큰 갱신 완료:', accessToken, refreshToken);
  return accessToken;
}

// ========== [4] Cafe24 API 요청 함수 ==========
async function apiRequest(method, url, data = {}, params = {}) {
  console.log(`Request: ${method} ${url}`);
  console.log("Params:", params);
  console.log("Data:", data);
  try {
    const response = await axios({
      method,
      url,
      data,
      params,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Cafe24-Api-Version': CAFE24_API_VERSION
      },
    });
    return response.data;
  } catch (error) {
    if (error.response && error.response.status === 401) {
      console.log('Access Token 만료. 갱신 중...');
      await refreshAccessToken();
      return apiRequest(method, url, data, params);
    } else {
      console.error('API 요청 오류:', error.response ? error.response.data : error.message);
      throw error;
    }
  }
}

// ========== [5] Cafe24 주문/배송 관련 함수 ==========
async function getOrderShippingInfo(memberId) {
  const API_URL = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders`;
  const today = new Date();
  const end_date = today.toISOString().split('T')[0];
  const twoWeeksAgo = new Date(today);
  twoWeeksAgo.setDate(today.getDate() - 14);
  const start_date = twoWeeksAgo.toISOString().split('T')[0];
  const params = {
    member_id: memberId,
    start_date: start_date,
    end_date: end_date,
    limit: 10,
  };
  try {
    const response = await apiRequest("GET", API_URL, {}, params);
    return response; // 응답 내 orders 배열
  } catch (error) {
    console.error("Error fetching order shipping info:", error.message);
    throw error;
  }
}

async function getShipmentDetail(orderId) {
  const API_URL = `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/orders/${orderId}/shipments`;
  const params = { shop_no: 1 };
  try {
    const response = await apiRequest("GET", API_URL, {}, params);
    if (response.shipments && response.shipments.length > 0) {
      const shipment = response.shipments[0];
      // 배송사 코드에 따른 이름과 링크 매핑
      const shippingCompanies = {
        "0019": { name: "롯데 택배", url: "https://www.lotteglogis.com/home/reservation/tracking/index" },
        "0039": { name: "경동 택배", url: "https://kdexp.com/index.do" }
      };
      if (shippingCompanies[shipment.shipping_company_code]) {
        shipment.shipping_company_name = shippingCompanies[shipment.shipping_company_code].name;
        shipment.shipping_company_url = shippingCompanies[shipment.shipping_company_code].url;
      } else {
        shipment.shipping_company_name = shipment.shipping_company_code || "물류 창고";
        shipment.shipping_company_url = null;
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

// ========== [6] 기타 유틸 함수 ==========
function normalizeSentence(sentence) {
  return sentence
    .replace(/[?!！？]/g, "")
    .replace(/없나요/g, "없어요")
    .trim();
}

function containsOrderNumber(input) {
  return /\d{8}-\d{7}/.test(input);
}

// ========== [7] OpenAI GPT (fallback) - 맥락(컨텍스트) 주입 ==========
async function getGPT3TurboResponse(userInput) {
  try {
    const response = await axios.post(
      OPEN_URL,
      {
        model: FINETUNED_MODEL,
        messages: [
          { role: "system", content: YOGIBO_SYSTEM_PROMPT },
          { role: "user", content: userInput }
        ]
      },
      {
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );
    const gptAnswer = response.data.choices[0].message.content;
    // GPT 응답에 자동 띄어쓰기 적용
    const formattedAnswer = addSpaceAfterPeriod(gptAnswer);
    return formattedAnswer;
  } catch (error) {
    console.error("Error calling OpenAI:", error.message);
    return "요기보 챗봇 오류가 발생했습니다. 다시 시도 부탁드립니다.";
  }
}

// 점(.) 뒤에 공백이 없는 경우 자동 추가하는 함수
function addSpaceAfterPeriod(text) {
  return text.replace(/\.([^\s])/g, '. $1');
}

// ========== [8] 대화 로그 저장 함수 (당일 동일 아이디 대화는 배열로 업데이트) ==========
async function saveConversationLog(memberId, userMessage, botResponse) {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection("conversationLogs");
    // 오늘 날짜 (YYYY-MM-DD)
    const today = new Date().toISOString().split("T")[0];
    const query = {
      memberId: (memberId && memberId !== "null") ? memberId : null,
      date: today
    };
    const existingLog = await collection.findOne(query);
    const logEntry = {
      userMessage,
      botResponse,
      createdAt: new Date()
    };
    if (existingLog) {
      // 이미 당일 대화가 있으면 conversation 배열에 새 항목 추가
      await collection.updateOne(query, { $push: { conversation: logEntry } });
      console.log("대화 로그 업데이트 성공");
    } else {
      // 당일 대화가 없으면 새 문서 생성
      await collection.insertOne({
        memberId: (memberId && memberId !== "null") ? memberId : null,
        date: today,
        conversation: [logEntry]
      });
      console.log("새 대화 로그 생성 및 저장 성공");
    }
  } catch (error) {
    console.error("대화 로그 저장 중 오류:", error.message);
  } finally {
    await client.close();
  }
}

// ========== [9] 메인 로직: findAnswer ==========
async function findAnswer(userInput, memberId) {
  const normalizedUserInput = normalizeSentence(userInput);

  /************************************************
   * A. JSON 기반 FAQ / 제품 안내 로직
   ************************************************/
  // (1) 세탁 방법 맥락 처리
  if (pendingWashingContext) {
    const washingMap = {
      "요기보": "요기보",
      "줄라": "줄라",
      "럭스": "럭스",
      "모듀": "모듀",
      "메이트": "메이트"
    };
    for (let key in washingMap) {
      if (normalizedUserInput.includes(key)) {
        if (companyData.washing && companyData.washing[key]) {
          pendingWashingContext = false;
          return {
            text: companyData.washing[key].description,
            videoHtml: null,
            description: null,
            imageUrl: null
          };
        }
      }
    }
    pendingWashingContext = false;
    return {
      text: "해당 커버 종류를 찾지 못했어요. (요기보, 줄라, 럭스, 모듀, 메이트 중 하나를 입력해주세요.)",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }
  if (
    normalizedUserInput.includes("세탁방법") ||
    (normalizedUserInput.includes("세탁") && normalizedUserInput.includes("방법"))
  ) {
    pendingWashingContext = true;
    return {
      text: "어떤 커버(제품) 세탁 방법이 궁금하신가요? (요기보, 줄라, 럭스, 모듀, 메이트 등)",
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }

  // (2) 커버링 방법 맥락 처리
  if (pendingCoveringContext) {
    const coveringTypes = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
    if (coveringTypes.includes(normalizedUserInput)) {
      const key = `${normalizedUserInput} 커버링 방법을 알고 싶어`;
      if (companyData.covering && companyData.covering[key]) {
        const videoUrl = companyData.covering[key].videoUrl;
        pendingCoveringContext = false;
        return {
          text: companyData.covering[key].answer,
          videoHtml: videoUrl
            ? `<iframe width="100%" height="auto" src="${videoUrl}" frameborder="0" allowfullscreen></iframe>`
            : null,
          description: null,
          imageUrl: null
        };
      }
      pendingCoveringContext = false;
    }
  }
  if (
    normalizedUserInput.includes("커버링") &&
    normalizedUserInput.includes("방법") &&
    !normalizedUserInput.includes("주문")
  ) {
    const coveringTypes2 = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
    const foundType = coveringTypes2.find(type => normalizedUserInput.includes(type));
    if (foundType) {
      const key = `${foundType} 커버링 방법을 알고 싶어`;
      console.log("커버링 key:", key);
      if (companyData.covering && companyData.covering[key]) {
        const videoUrl = companyData.covering[key].videoUrl;
        console.log("videoUrl:", videoUrl);
        return {
          text: companyData.covering[key].answer,
          videoHtml: videoUrl
            ? `<iframe width="100%" height="auto" src="${videoUrl}" frameborder="0" allowfullscreen></iframe>`
            : null,
          description: null,
          imageUrl: null
        };
      } else {
        console.warn(`companyData.covering 에 "${key}" 키가 없습니다.`);
      }
    } else {
      pendingCoveringContext = true;
      return {
        text: "어떤 커버링을 알고 싶으신가요? (맥스, 더블, 프라임, 슬림, 미니 등)",
        videoHtml: null,
        description: null,
        imageUrl: null
      };
    }
  }

  // (3) 사이즈 안내
  const sizeTypes = ["더블", "맥스", "프라임", "슬림", "미디", "미니", "팟", "드롭", "라운저", "피라미드"];
  if (
    normalizedUserInput.includes("사이즈") ||
    normalizedUserInput.includes("크기")
  ) {
    for (let sizeType of sizeTypes) {
      if (normalizedUserInput.includes(sizeType)) {
        const key = sizeType + " 사이즈 또는 크기.";
        if (companyData.sizeInfo && companyData.sizeInfo[key]) {
          return {
            text: companyData.sizeInfo[key].description,
            videoHtml: null,
            description: null,
            imageUrl: companyData.sizeInfo[key].imageUrl
          };
        }
      }
    }
  }

  // (4) 비즈 안내
  const bizKeywords = ["스탠다드", "프리미엄", "프리미엄 플러스", "비즈"];
  if (bizKeywords.some(bw => normalizedUserInput.includes(bw))) {
    let matchedType = null;
    if (normalizedUserInput.includes("스탠다드")) matchedType = "스탠다드";
    else if (normalizedUserInput.includes("프리미엄 플러스")) matchedType = "프리미엄 플러스";
    else if (normalizedUserInput.includes("프리미엄")) matchedType = "프리미엄";
    if (matchedType) {
      const key = `${matchedType} 비즈 에 대해 알고 싶어`;
      if (companyData.biz && companyData.biz[key]) {
        return {
          text: companyData.biz[key].description,
          videoHtml: null,
          description: null,
          imageUrl: null
        };
      } else {
        return {
          text: `${matchedType} 비즈 정보가 없습니다. (JSON에 등록되어 있는지 확인해주세요)`,
          videoHtml: null,
          description: null,
          imageUrl: null
        };
      }
    } else {
      return {
        text: "어떤 비즈가 궁금하신가요? (스탠다드, 프리미엄, 프리미엄 플러스 등)",
        videoHtml: null,
        description: null,
        imageUrl: null
      };
    }
  }

  // (6) goodsInfo (유사도 매칭)
  if (companyData.goodsInfo) {
    let bestGoodsMatch = null;
    let bestGoodsDistance = Infinity;
    for (let question in companyData.goodsInfo) {
      const distance = levenshtein.get(normalizedUserInput, normalizeSentence(question));
      if (distance < bestGoodsDistance) {
        bestGoodsDistance = distance;
        bestGoodsMatch = companyData.goodsInfo[question];
      }
    }
    if (bestGoodsDistance < 6 && bestGoodsMatch) {
      return {
        text: Array.isArray(bestGoodsMatch.description)
          ? bestGoodsMatch.description.join("\n")
          : bestGoodsMatch.description,
        videoHtml: null,
        description: null,
        imageUrl: bestGoodsMatch.imageUrl || null
      };
    }
  }

  // (7) homePage 유사도 매칭
  if (companyData.homePage) {
    let bestHomeMatch = null;
    let bestHomeDist = Infinity;
    for (let question in companyData.homePage) {
      const distance = levenshtein.get(normalizedUserInput, normalizeSentence(question));
      if (distance < bestHomeDist) {
        bestHomeDist = distance;
        bestHomeMatch = companyData.homePage[question];
      }
    }
    if (bestHomeDist < 5 && bestHomeMatch) {
      return {
        text: bestHomeMatch.description,
        videoHtml: null,
        description: null,
        imageUrl: null
      };
    }
  }

  // (8) asInfo 정보
  if (companyData.asInfoList) {
    let asInfoMatch = null;
    let asInfoDist = Infinity;
    for (let question in companyData.asInfo) {
      const distance = levenshtein.get(normalizedUserInput, normalizeSentence(question));
      if (distance < asInfoDist) {
        asInfoDist = distance;
        asInfoMatch = companyData.asInfo[question];
      }
    }
    if (asInfoDist < 8 && asInfoMatch) {
      return {
        text: asInfoMatch.description,
        videoHtml: null,
        description: null,
        imageUrl: null
      };
    }
  }

  if (
    normalizedUserInput.includes("상담사 연결") ||
    normalizedUserInput.includes("상담원 연결")
  ) {
    return {
      text: `
      상담사와 연결을 도와드릴게요.<br>
      <a href="http://pf.kakao.com/_lxmZsxj/chat" target="_blank" style="border-radius:10px;float:left; padding-inline:10px;background:#58b5ca;color:#fff;line-height:7px;">
        카카오플친 연결하기
      </a>
      <a href="https://talk.naver.com/ct/wc4u67?frm=psf" target="_blank" style="border-radius:10px;padding-inline:10px;float:left;background:#58b5ca;color:#fff;">
        네이버톡톡 연결하기
      </a>
      `,
      videoHtml: null,
      description: null,
      imageUrl: null
    };
  }

  /************************************************
   * B. Café24 주문/배송 로직
   ************************************************/
  // (9) 회원 아이디 조회
  if (
    normalizedUserInput.includes("내 아이디") ||
    normalizedUserInput.includes("나의 아이디") ||
    normalizedUserInput.includes("아이디 조회") ||
    normalizedUserInput.includes("아이디 알려줘")
  ) {
    if (memberId && memberId !== "null") {
      return {
        text: `안녕하세요 ${memberId} 고객님, 궁금하신 사항을 남겨주세요.`,
        videoHtml: null,
        description: null,
        imageUrl: null,
      };
    } else {
      return {
        text: `안녕하세요 고객님 회원가입을 통해 요기보의 다양한 이벤트 혜택을 만나보실수 있어요! <a href="/member/login.html" target="_blank">회원가입 하러가기</a>`,
        videoHtml: null,
        description: null,
        imageUrl: null,
      };
    }
  }

  // (10) 주문번호가 포함된 경우 처리
  if (containsOrderNumber(normalizedUserInput)) {
    if (memberId && memberId !== "null") {
      try {
        const match = normalizedUserInput.match(/\d{8}-\d{7}/);
        const targetOrderNumber = match ? match[0] : "";
        const shipment = await getShipmentDetail(targetOrderNumber);
        if (shipment) {
          console.log("Shipment 전체 데이터:", shipment);
          console.log("shipment.status 값:", shipment.status);
          console.log("shipment.items 값:", shipment.items);
          const shipmentStatus =
            shipment.status || (shipment.items && shipment.items.length > 0 ? shipment.items[0].status : undefined);
          const itemStatusMap = {
            standby: "배송대기",
            shipping: "배송중",
            shipped: "배송완료",
            shipready:"배송준비중" 
          };
          const statusText = itemStatusMap[shipmentStatus] || shipmentStatus || "배송 완료";
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
      {
        return { 
          text: `배송은 제품 출고 후 1~3 영업일 정도 소요되며, 제품별 출고 시 소요되는 기간은 아래 내용을 확인해주세요.
          - 소파 및 바디필로우: 주문 확인 후 제작되는 제품으로, 3~7 영업일 이내에 출고됩니다.
          - 모듀(모듈러) 소파: 주문 확인일로부터 1~3 영업일 이내에 출고됩니다.
          - 그 외 제품: 주문 확인일로부터 1~3 영업일 이내에 출고됩니다.
          일부 제품은 오후 1시 이전에 구매를 마쳐주시면 당일 출고될 수 있어요.
          개별 배송되는 제품을 여러 개 구매하신 경우 제품이 여러 차례로 나눠 배송될 수 있습니다.
          주문 폭주 및 재난 상황이나 천재지변, 택배사 사정 등에 의해 배송 일정이 일부 변경될 수 있습니다.
          추가 문의사항이 있으신 경우 Yogibo 고객센터로 문의해주세요.`
        };
      }
    }
  }
  
  // (11) 주문번호 없이 주문상태 확인 처리
  if (
    (normalizedUserInput.includes("주문상태 확인") ||
      normalizedUserInput.includes("배송") ||
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
            const shipmentStatus =
              shipment.status || (shipment.items && shipment.items.length > 0 ? shipment.items[0].status : undefined);
            const itemStatusMap = {
              standby: "배송대기",
              shipping: "배송중",
              shipped: "배송완료",
              shipready:"배송준비중",
            };
            const statusText = itemStatusMap[shipmentStatus] || shipmentStatus || "배송완료";
            const trackingNo = shipment.tracking_no || "등록전";
            let shippingCompany = shipment.shipping_company_name || "등록전";
    
            if (shippingCompany === "롯데 택배") {
              shippingCompany = `<a href="https://www.lotteglogis.com/home/reservation/tracking/index">${shippingCompany}</a>`;
            } else if (shippingCompany === "경동 택배") {
              shippingCompany = `<a href="https://kdexp.com/index.do" target="_blank">${shippingCompany}</a>`;
            }
    
            return {
              text: `고객님께서 주문하신 상품은 ${shippingCompany}를 통해 ${statusText} 이며, 운송장 번호는 ${trackingNo} 입니다.`,
              videoHtml: null,
              description: null,
              imageUrl: null,
            };
          } else {
            return { text: "해당 주문에 대한 배송 상세 정보를 찾을 수 없습니다." };
          }
        } else {
          return { 
            text: `배송은 제품 출고 후 1~3 영업일 정도 소요되며, 제품별 출고 시 소요되는 기간은 아래 내용을 확인해주세요.
            - 소파 및 바디필로우: 주문 확인 후 제작되는 제품으로, 3~7 영업일 이내에 출고됩니다.
            - 모듀(모듈러) 소파: 주문 확인일로부터 1~3 영업일 이내에 출고됩니다.
            - 그 외 제품: 주문 확인일로부터 1~3 영업일 이내에 출고됩니다.
            일부 제품은 오후 1시 이전에 구매를 마쳐주시면 당일 출고될 수 있어요.
            개별 배송되는 제품을 여러 개 구매하신 경우 제품이 여러 차례로 나눠 배송될 수 있습니다.
            주문 폭주 및 재난 상황이나 천재지변, 택배사 사정 등에 의해 배송 일정이 일부 변경될 수 있습니다.
            추가 문의사항이 있으신 경우 Yogibo 고객센터로 문의해주세요.`
          };
        }
      } catch (error) {
        return { text: "고객님의 주문 정보를 찾을 수 없습니다. 주문 여부를 확인해주세요." };
      }
    } else {
      {
        return { 
          text: `배송은 제품 출고 후 1~3 영업일 정도 소요되며, 제품별 출고 시 소요되는 기간은 아래 내용을 확인해주세요.
          - 소파 및 바디필로우: 주문 확인 후 제작되는 제품으로, 3~7 영업일 이내에 출고됩니다.
          - 모듀(모듈러) 소파: 주문 확인일로부터 1~3 영업일 이내에 출고됩니다.
          - 그 외 제품: 주문 확인일로부터 1~3 영업일 이내에 출고됩니다.
          일부 제품은 오후 1시 이전에 구매를 마쳐주시면 당일 출고될 수 있어요.
          개별 배송되는 제품을 여러 개 구매하신 경우 제품이 여러 차례로 나눠 배송될 수 있습니다.
          주문 폭주 및 재난 상황이나 천재지변, 택배사 사정 등에 의해 배송 일정이 일부 변경될 수 있습니다.
          추가 문의사항이 있으신 경우 Yogibo 고객센터로 문의해주세요.`
        };
      }
    }
  }
  
  /************************************************
   * C. 최종 fallback
   ************************************************/
  return {
    text: "질문을 이해하지 못했어요. 좀더 자세히 입력 해주시겠어요",
    videoHtml: null,
    description: null,
    imageUrl: null,
  };
}

// ========== [12] /chat 라우팅 ==========
app.post("/chat", async (req, res) => {
  const userInput = req.body.message;
  const memberId = req.body.memberId; // 프론트에서 전달한 회원 ID
  if (!userInput) {
    return res.status(400).json({ error: "Message is required" });
  }

  try {
    const answer = await findAnswer(userInput, memberId);
    let finalAnswer = answer;
    if (answer.text === "질문을 이해하지 못했어요. 좀더 자세히 입력 해주시겠어요") {
      const gptResponse = await getGPT3TurboResponse(userInput);
      finalAnswer = {
        text: gptResponse,
        videoHtml: null,
        description: null,
        imageUrl: null
      };
    }
    // "내아이디" 검색어인 경우에는 로그 저장을 건너뜁니다.
    if (normalizeSentence(userInput) !== "내 아이디") {
      await saveConversationLog(memberId, userInput, finalAnswer.text);
    }
    return res.json(finalAnswer);
  } catch (error) {
    console.error("Error in /chat endpoint:", error.message);
    return res.status(500).json({
      text: "질문을 이해하지 못했어요. 좀더 자세히 입력 해주시겠어요",
      videoHtml: null,
      description: null,
      imageUrl: null
    });
  }
});

//대화 내용 적용 로직
app.get('/chatConnet', async (req, res) => {
  const client = new MongoClient(MONGODB_URI);
  try {
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection("conversationLogs");
    const data = await collection.find({}).toArray();

    // 새로운 Excel 워크북과 워크시트 생성
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('ConversationList');

    // 워크시트 컬럼 헤더 설정
    worksheet.columns = [
      { header: '회원아이디', key: 'memberId', width: 15 },
      { header: '날짜', key: 'date', width: 15 },
      { header: '대화내용', key: 'conversation', width: 50 },
    ];

    // 각 문서마다 한 행씩 추가 (conversation 배열은 JSON 문자열로 변환)
    data.forEach(doc => {
      worksheet.addRow({
        memberId: doc.memberId || '비회원',
        date: doc.date,
        conversation: JSON.stringify(doc.conversation, null, 2)
      });
    });

    // 응답 헤더 설정 후 워크북을 스트림으로 전송 (Excel 다운로드)
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", "attachment; filename=conversationLogs.xlsx");

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error("Excel 파일 생성 중 오류:", error.message);
    res.status(500).send("Excel 파일 생성 중 오류가 발생했습니다.");
  } finally {
    await client.close();
  }
});
//채팅 응답 답변에 대한 데이터 추가 
/******************************************************
 * server.js - 기존 코드 + 포스트잇(질문/답변) 저장 로직
 ******************************************************/

// ... 기존 import, 환경변수, MongoClient, Express 설정 등...

// 새로 추가할 collection 이름
const postItCollectionName = "postItNotes";

// [A] 포스트잇 노트 조회 (페이징)
app.get("/postIt", async (req, res) => {
  // page 쿼리 파라미터 (기본 1페이지)
  const page = parseInt(req.query.page) || 1;
  const PAGE_SIZE = 10;

  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(postItCollectionName);

    // 전체 문서 수
    const totalCount = await collection.countDocuments({});
    // 총 페이지 수
    const totalPages = Math.ceil(totalCount / PAGE_SIZE);

    // 페이지 범위 보정
    let currentPage = page;
    if (currentPage < 1) currentPage = 1;
    if (totalPages > 0 && currentPage > totalPages) currentPage = totalPages;

    // 스킵/리밋
    const skipCount = (currentPage - 1) * PAGE_SIZE;

    // 최신 등록이 맨 위에 오도록 정렬(descending)
    const notes = await collection
      .find({})
      .sort({ _id: -1 })
      .skip(skipCount)
      .limit(PAGE_SIZE)
      .toArray();
      notes.forEach(doc => {
        doc._id = doc._id.toString();
      });
    await client.close();

    return res.json({
      notes,            // 현재 페이지 노트 목록
      currentPage,      // 현재 페이지
      totalPages,       // 총 페이지 수
      totalCount,       // 전체 노트 개수
      pageSize: PAGE_SIZE
    });
  } catch (error) {
    console.error("GET /postIt 오류:", error.message);
    return res.status(500).json({ error: "포스트잇 목록 조회 중 오류가 발생했습니다." });
  }
});

// [B] 포스트잇 노트 등록
app.post("/postIt", async (req, res) => {
  const { question, answer } = req.body;
  if (!question && !answer) {
    return res.status(400).json({ error: "질문 또는 답변이 비어있습니다." });
  }

  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(postItCollectionName);

    // DB에 저장할 문서
    const newNote = {
      question,
      answer,
      createdAt: new Date()
      // 필요하다면 color 등 필드 추가 가능
    };

    const result = await collection.insertOne(newNote);
    await client.close();

    // 성공 시 새로 등록된 문서 반환
    return res.json({
      message: "포스트잇 등록 성공",
      note: newNote
    });
  } catch (error) {
    console.error("POST /postIt 오류:", error.message);
    return res.status(500).json({ error: "포스트잇 등록 중 오류가 발생했습니다." });
  }
});

// [C] 포스트잇 노트 수정
app.put("/postIt/:id", async (req, res) => {
  const noteId = req.params.id;   // 문자열
  const { question, answer } = req.body;

  // _id 변환
  const { ObjectId } = require("mongodb");
  const filter = { _id: new ObjectId(noteId) };

  // 업데이트할 필드
  const updateData = {
    ...(question && { question }),
    ...(answer && { answer }),
    updatedAt: new Date()
  };

  // findOneAndUpdate
  const result = await collection.findOneAndUpdate(
    filter,
    { $set: updateData },
    { returnDocument: "after" } // 수정 후 문서 반환
  );

  if (!result.value) {
    return res.status(404).json({ error: "해당 포스트잇을 찾을 수 없습니다." });
  }

  return res.json({
    message: "포스트잇 수정 성공",
    note: result.value
  });
});


// [D] 포스트잇 노트 삭제
app.delete("/postIt/:id", async (req, res) => {
  const noteId = req.params.id;

  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db(DB_NAME);
    const collection = db.collection(postItCollectionName);

    const { ObjectId } = require("mongodb");
    const filter = { _id: new ObjectId(noteId) };

    const result = await collection.deleteOne(filter);
    await client.close();

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "삭제할 포스트잇을 찾지 못했습니다." });
    }

    return res.json({ message: "포스트잇 삭제 성공" });
  } catch (error) {
    console.error("DELETE /postIt 오류:", error.message);
    return res.status(500).json({ error: "포스트잇 삭제 중 오류가 발생했습니다." });
  }
});



// ========== [13] 서버 시작 ==========
(async function initialize() {
  await getTokensFromDB();  // MongoDB에서 토큰 불러오기
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
  });
})();
