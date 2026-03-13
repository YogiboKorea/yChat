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
<div class="consult-container" style="background:#fff; border:1px solid #eaeaea; border-radius:12px; padding:15px; margin-top:10px; box-shadow:0 2px 8px rgba(0,0,0,0.05);">
  <p style="font-size:14px; color:#333; margin-bottom:12px; line-height:1.5; font-weight:500;">
    <i class="fa-solid fa-circle-info" style="color:#58b5ca;"></i> 해당 내용에 대한 정확한 정보는 상담사를 통해 확인이 필요합니다.
  </p>
  <a href="javascript:void(0)" onclick="window.open('http://pf.kakao.com/_lxmZsxj/chat','kakao','width=500,height=600,scrollbars=yes');" class="consult-btn kakao" style="display:flex; align-items:center; justify-content:center; padding:10px; margin-bottom:8px; border-radius:8px; background:#FEE500; color:#000; text-decoration:none; font-weight:bold; font-size:14px;">
     <i class="fa-solid fa-comment" style="margin-right:6px;"></i> 카카오톡 상담원 연결
  </a>
  <a href="javascript:void(0)" onclick="window.open('https://talk.naver.com/ct/wc4u67?frm=psf','naver','width=500,height=600,scrollbars=yes');" class="consult-btn naver" style="display:flex; align-items:center; justify-content:center; padding:10px; border-radius:8px; background:#03C75A; color:#fff; text-decoration:none; font-weight:bold; font-size:14px;">
     <i class="fa-solid fa-comments" style="margin-right:6px;"></i> 네이버 톡톡 상담원 연결
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
