function formatResponseText(text) { 
    return text || ""; 
}

function normalizeSentence(s) { 
    return s.replace(/[?!！？]/g, "").replace(/없나요/g, "없어요").trim(); 
}

function containsOrderNumber(s) { 
    return /\d{8}-\d{7}/.test(s); 
}

function isUserLoggedIn(id) { 
    return id && id !== "null" && id !== "undefined" && String(id).trim() !== ""; 
}

const COUNSELOR_LINKS_HTML = `
<div class="consult-container">
  <p style="font-weight:bold; margin-bottom:8px; font-size:14px; color:#e74c3c;">
    <i class="fa-solid fa-triangle-exclamation"></i> 정확한 정보 확인이 필요합니다.
  </p>
  <p style="font-size:13px; color:#555; margin-bottom:15px; line-height:1.4;">
    죄송합니다. 현재 데이터베이스에서 정확한 답변을 찾지 못했습니다.<br>
    사람의 확인이 필요한 내용일 수 있으니, 아래 버튼을 눌러 <b>상담사</b>에게 문의해주세요.
  </p>
  <a href="javascript:void(0)" onclick="window.open('http://pf.kakao.com/_lxmZsxj/chat','kakao','width=500,height=600,scrollbars=yes');" class="consult-btn kakao">
     <i class="fa-solid fa-comment"></i> 카카오톡 상담원으로 연결
  </a>
  <a href="javascript:void(0)" onclick="window.open('https://talk.naver.com/ct/wc4u67?frm=psf','naver','width=500,height=600,scrollbars=yes');" class="consult-btn naver">
     <i class="fa-solid fa-comments"></i> 네이버 톡톡 상담원으로 연결
  </a>
</div>
`;

const COUNSELOR_BUTTONS_ONLY_HTML = `
<div class="consult-container">
    <p style="font-weight:bold; margin-bottom:8px; font-size:14px; color:#e74c3c;">
    <i class="fa-solid fa-triangle-exclamation"></i> 상담사 연결을 진행하겠습니다.
  </p>
  <a href="javascript:void(0)" onclick="window.open('http://pf.kakao.com/_lxmZsxj/chat','kakao','width=500,height=600,scrollbars=yes');" class="consult-btn kakao">
     <i class="fa-solid fa-comment"></i> 카카오톡 상담원으로 연결
  </a>
  <a href="javascript:void(0)" onclick="window.open('https://talk.naver.com/ct/wc4u67?frm=psf','naver','width=500,height=600,scrollbars=yes');" class="consult-btn naver">
     <i class="fa-solid fa-comments"></i> 네이버 톡톡 상담원으로 연결
  </a>
</div>
`;

const FALLBACK_MESSAGE_HTML = `<div style="margin-top: 10px;">${COUNSELOR_LINKS_HTML}</div>`;
const LOGIN_BTN_HTML = `<div style="margin-top:15px;"><a href="/member/login.html" class="consult-btn" style="background:#58b5ca; color:#fff; justify-content:center;">로그인 하러 가기 →</a></div>`;

module.exports = {
    formatResponseText,
    normalizeSentence,
    containsOrderNumber,
    isUserLoggedIn,
    COUNSELOR_LINKS_HTML,
    COUNSELOR_BUTTONS_ONLY_HTML,
    FALLBACK_MESSAGE_HTML,
    LOGIN_BTN_HTML
};
