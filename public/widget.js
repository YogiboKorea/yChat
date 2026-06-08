;(function () {
  // ────────────────────────────────────────────────────────────────
  // 0) 스크립트/설정값
  //    - script.src 의 origin = 이벤트 데이터 서버 (이 앱의 도메인)
  //    - data-api-base       = cafe24 상품/카테고리/트래킹 서버 (ychat)
  //    - data-page-id        = 이벤트 ID (MongoDB _id)
  //    - data-mall-id        = cafe24 mall id
  // ────────────────────────────────────────────────────────────────
  let script = document.currentScript;
  if (!script || !script.dataset.pageId) {
    script = Array.from(document.getElementsByTagName('script')).find(s =>
      /widget\.js/.test(s.src) && s.dataset.pageId
    );
  }
  if (!script || !script.dataset.pageId) {
    console.warn('⚠️ widget.js: data-page-id 누락');
    return;
  }

  const SELF_BASE = (() => {
    try { return new URL(script.src).origin; } catch (e) { return ''; }
  })();
  const PRODUCT_API_BASE = script.dataset.apiBase || '';
  const pageId = script.dataset.pageId;
  const mallId = script.dataset.mallId || 'yogibo';
  // 쿠폰 번호 — embed 스크립트 태그의 data-coupon-nos 가 초기값.
  // initializePage 에서 이벤트 데이터의 ev.couponNos 가 있으면 그걸로 덮어써서
  // cafe24 HTML 재배포 없이 admin 편집만으로 실시간 반영되게 한다.
  let couponNos = script.dataset.couponNos || '';
  // 매 호출 시점 최신 couponNos 로 쿼리스트링 생성 — 동적 갱신 대비.
  const couponQSStart = () => couponNos ? `?coupon_no=${couponNos}` : '';
  const couponQSAppend = () => couponNos ? `&coupon_no=${couponNos}` : '';
  // 이벤트 페이지 전체 콘텐츠 최대 너비(px). initializePage 에서 ev.pageMaxWidth 로 덮어씀.
  let pageMaxWidth = 800;

  // ────────────────────────────────────────────────────────────────
  // 1) 유틸/트래킹 (ychat 의 /api/{mallId}/track 그대로 사용)
  // ────────────────────────────────────────────────────────────────
  const ua = navigator.userAgent;
  const device = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : 'PC';
  const visitorId = (() => {
    const key = 'appVisitorId';
    try {
      let id = localStorage.getItem(key);
      if (!id) {
        id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
        localStorage.setItem(key, id);
      }
      return id;
    } catch (e) {
      return (crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
    }
  })();

  const pad = n => String(n).padStart(2, '0');
  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function shouldTrack() {
    try {
      if (/[?&]track=true/.test(location.search)) return true;
      const key = `tracked_${pageId}_${visitorId}_${today()}`;
      if (sessionStorage.getItem(key)) return false;
      sessionStorage.setItem(key, '1');
      return true;
    } catch (e) {
      return true;
    }
  }
  function track(payload) {
    if (!PRODUCT_API_BASE) return;
    fetch(`${PRODUCT_API_BASE}/api/${mallId}/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }
  if (shouldTrack()) {
    track({ pageId, pageUrl: location.pathname, visitorId, type: 'view', device, referrer: document.referrer || 'direct', timestamp: new Date().toISOString() });
  } else {
    track({ pageId, pageUrl: location.pathname, visitorId, type: 'revisit', device, referrer: document.referrer || 'direct', timestamp: new Date().toISOString() });
  }
  document.body.addEventListener('click', (e) => {
    const el = e.target.closest('[data-track-click]');
    if (!el) return;
    const elementType = el.dataset.trackClick;
    const payload = { pageId, pageUrl: location.pathname, visitorId, type: 'click', element: elementType, device, referrer: document.referrer || 'direct', timestamp: new Date().toISOString() };
    if (elementType === 'product') {
      const productNo = el.dataset.productNo;
      if (productNo) payload.productNo = productNo;
    }
    track(payload);
  });

  // ────────────────────────────────────────────────────────────────
  // 2) 공통 헬퍼
  // ────────────────────────────────────────────────────────────────
  function escapeHtml(s = '') { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function toBool(v) { return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'; }

  function fetchWithRetry(url, opts = {}, retries = 3, backoff = 1000) {
    return fetch(url, opts).then(res => {
      if (res.status === 429 && retries > 0) {
        return new Promise(r => setTimeout(r, backoff)).then(() => fetchWithRetry(url, opts, retries - 1, backoff * 2));
      }
      if (!res.ok) throw res;
      return res;
    });
  }

  function buildYouTubeSrc(id, autoplay = false, loop = false) {
    const params = new URLSearchParams({ autoplay: autoplay ? '1' : '0', mute: autoplay ? '1' : '0', playsinline: '1', rel: 0, modestbranding: 1, enablejsapi: 1 });
    if (loop) { params.set('loop', '1'); params.set('playlist', id); }
    return `https://www.youtube.com/embed/${id}?${params.toString()}`;
  }

  // 카페24 상품 URL 정규화 — iOS Safari 다운로드 다이얼로그 우회
  function normalizeHref(rawHref) {
    if (!rawHref) return null;
    let href = String(rawHref).trim();
    if (!href || href === '#') return null;
    if (/^\d+$/.test(href) || href.length < 4) return null;

    let decoded = href;
    try { decoded = decodeURI(href); } catch (e) { decoded = href; }

    const m = decoded.match(/\/product\/[^\/]+\/(\d+)(?:\/category\/(\d+))?/);
    if (m) {
      try {
        const baseForOrigin = /^https?:\/\//i.test(href) ? href : `https://${href}`;
        const u = new URL(baseForOrigin);
        const productNo = m[1];
        const cateNo = m[2];
        return `${u.origin}/product/detail.html?product_no=${productNo}` + (cateNo ? `&cate_no=${cateNo}` : '');
      } catch (e) { return null; }
    }

    try {
      const finalUrl = /^https?:\/\//i.test(href) ? href : `https://${href}`;
      const u = new URL(finalUrl);
      if (!u.hostname.includes('.')) return null;
      return finalUrl;
    } catch (e) { return null; }
  }

  // ────────────────────────────────────────────────────────────────
  // 3) 블록 렌더링
  // ────────────────────────────────────────────────────────────────
  function getRootContainer() {
    let root = document.getElementById('evt-root');
    if (!root) {
      root = document.createElement('div');
      root.id = 'evt-root';
      script.parentNode.insertBefore(root, script);
    }
    root.innerHTML = '';
    return root;
  }

  function renderImageBlock(block, root) {
    const wrap = document.createElement('div');
    wrap.style.cssText = `position:relative; margin:0 auto; width:100%; max-width:${pageMaxWidth}px; font-size:0;`;
    const img = document.createElement('img');
    // 배너 이미지는 우선 로드 — 상품 데이터 fetch 보다 먼저 빠르게 표시되도록.
    img.decoding = 'async';
    try { img.fetchPriority = 'high'; } catch (e) { /* 일부 브라우저 미지원 */ }
    img.src = block.src;
    img.style.cssText = 'max-width:100%; height:auto; display:block; margin:0 auto;';
    wrap.appendChild(img);
    (block.regions || []).forEach(r => {
      const l = (r.xRatio * 100).toFixed(2), t = (r.yRatio * 100).toFixed(2), w = (r.wRatio * 100).toFixed(2), h = (r.hRatio * 100).toFixed(2);
      if (r.coupon) {
        const btn = document.createElement('button');
        btn.dataset.couponNo = r.coupon;
        btn.onclick = () => window.downloadCoupon(r.coupon);
        btn.style.cssText = `position:absolute; left:${l}%; top:${t}%; width:${w}%; height:${h}%; border:none; cursor:pointer; background:transparent;`;
        wrap.appendChild(btn);
      } else if (r.tabTarget && r.tabTarget.blockId != null && r.tabTarget.tabIndex != null) {
        // 탭 이동 region — 클릭 시 해당 product_group 의 i 번째 탭을 활성화하고 스크롤.
        const btn = document.createElement('button');
        btn.dataset.tabBlockId = r.tabTarget.blockId;
        btn.dataset.tabIndex = String(r.tabTarget.tabIndex);
        btn.onclick = () => {
          const targetPanelId = `${r.tabTarget.blockId}-tab-${r.tabTarget.tabIndex}`;
          const panel = document.getElementById(targetPanelId);
          if (!panel) return;
          // 같은 group-wrapper 안의 탭 버튼을 찾아 클릭 (활성화 + showTab 호출)
          const groupWrapper = panel.parentElement;
          const tabBtns = groupWrapper ? groupWrapper.querySelectorAll(`.tabs_${pageId} button`) : null;
          const targetBtn = tabBtns ? tabBtns[r.tabTarget.tabIndex] : null;
          if (targetBtn && typeof targetBtn.click === 'function') {
            targetBtn.click();
          }
          // 부드러운 스크롤로 해당 탭 패널 상단으로 이동
          panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };
        btn.style.cssText = `position:absolute; left:${l}%; top:${t}%; width:${w}%; height:${h}%; border:none; cursor:pointer; background:transparent;`;
        wrap.appendChild(btn);
      } else if (r.popup && Array.isArray(r.popup.images) && r.popup.images.length) {
        // 팝업 region — 클릭 시 이미지 캐러셀 오버레이
        const btn = document.createElement('button');
        btn.onclick = () => window.openEventPopup(r.popup);
        btn.style.cssText = `position:absolute; left:${l}%; top:${t}%; width:${w}%; height:${h}%; border:none; cursor:pointer; background:transparent;`;
        wrap.appendChild(btn);
      } else if (r.href) {
        const safeHref = normalizeHref(r.href);
        if (!safeHref) return;
        const a = document.createElement('a');
        a.href = safeHref;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.style.cssText = `position:absolute; left:${l}%; top:${t}%; width:${w}%; height:${h}%; display:block;`;
        wrap.appendChild(a);
      }
    });
    root.appendChild(wrap);
  }

  // 이벤트 팝업 — 1~10장 이미지 캐러셀 오버레이. 닫기 버튼 + 각 이미지 링크 + 자동 순환.
  window.openEventPopup = (popup) => {
    const images = (popup && popup.images) || [];
    if (!images.length) return;
    const interval = Number(popup.interval) || 3000;

    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed; inset:0; z-index:99999; background:rgba(0,0,0,0.7); display:flex; align-items:center; justify-content:center; padding:20px; box-sizing:border-box;';

    const box = document.createElement('div');
    box.style.cssText = 'position:relative; max-width:480px; width:100%; max-height:100vh; overflow:hidden;';

    const slide = document.createElement('div');
    slide.style.cssText = 'position:relative; width:100%;';

    let idx = 0;
    let closeFn = () => {};
    const imgEls = images.map((im, i) => {
      const regions = Array.isArray(im.regions) ? im.regions : [];
      if (regions.length > 0) {
        const cell = document.createElement('div');
        cell.style.cssText = `display:${i === 0 ? 'block' : 'none'}; position:relative;`;
        const img = document.createElement('img');
        img.src = im.url; img.alt = '';
        img.style.cssText = 'width:100%; height:auto; display:block; border-radius:8px;';
        cell.appendChild(img);
        regions.forEach((rg) => {
          const rl = (rg.xRatio * 100).toFixed(2), rt = (rg.yRatio * 100).toFixed(2), rw = (rg.wRatio * 100).toFixed(2), rh = (rg.hRatio * 100).toFixed(2);
          if (rg.action === 'close') {
            const cb = document.createElement('button');
            cb.type = 'button';
            cb.style.cssText = `position:absolute; left:${rl}%; top:${rt}%; width:${rw}%; height:${rh}%; border:none; background:transparent; cursor:pointer;`;
            cb.onclick = (e) => { e.stopPropagation(); closeFn(); };
            cell.appendChild(cb);
          } else if (rg.action === 'link') {
            const safe = rg.href ? normalizeHref(rg.href) : '';
            if (!safe) return;
            const la = document.createElement('a');
            la.href = safe; la.target = '_blank'; la.rel = 'noopener noreferrer';
            la.style.cssText = `position:absolute; left:${rl}%; top:${rt}%; width:${rw}%; height:${rh}%; display:block;`;
            la.onclick = (e) => e.stopPropagation();
            cell.appendChild(la);
          }
        });
        slide.appendChild(cell);
        return cell;
      }
      const a = document.createElement('a');
      const safe = im.href ? normalizeHref(im.href) : '';
      if (safe) { a.href = safe; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      a.style.cssText = `display:${i === 0 ? 'block' : 'none'};`;
      const img = document.createElement('img');
      img.src = im.url;
      img.alt = '';
      img.style.cssText = 'width:100%; height:auto; display:block; border-radius:8px;';
      a.appendChild(img);
      slide.appendChild(a);
      return a;
    });

    const show = (n) => {
      idx = (n + imgEls.length) % imgEls.length;
      imgEls.forEach((el, i) => { el.style.display = i === idx ? 'block' : 'none'; });
    };

    const prevBodyOverflow = document.body.style.overflow;
    const close = () => { if (timer) clearInterval(timer); overlay.remove(); document.body.style.overflow = prevBodyOverflow || 'visible'; };
    closeFn = close;

    box.appendChild(slide);

    // 우상단 X 닫기 버튼 (선택). 끄면 닫기 영역으로만 닫힘.
    if (popup.showCloseButton !== false) {
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.innerHTML = '&times;';
      closeBtn.setAttribute('aria-label', '닫기');
      closeBtn.style.cssText = 'position:absolute; top:8px; right:8px; z-index:2; width:36px; height:36px; border:none; border-radius:50%; background:rgba(0,0,0,0.6); color:#fff; font-size:22px; line-height:36px; cursor:pointer;';
      closeBtn.onclick = (e) => { e.stopPropagation(); close(); };
      box.appendChild(closeBtn);
    }

    let timer = null;
    if (imgEls.length > 1) {
      const prev = document.createElement('button');
      prev.type = 'button';
      prev.innerHTML = '&#10094;';
      prev.style.cssText = 'position:absolute; top:50%; left:8px; transform:translateY(-50%); z-index:2; width:36px; height:36px; border:none; border-radius:50%; background:rgba(0,0,0,0.4); color:#fff; font-size:18px; cursor:pointer;';
      prev.onclick = (e) => { e.stopPropagation(); show(idx - 1); };
      const next = document.createElement('button');
      next.type = 'button';
      next.innerHTML = '&#10095;';
      next.style.cssText = 'position:absolute; top:50%; right:8px; transform:translateY(-50%); z-index:2; width:36px; height:36px; border:none; border-radius:50%; background:rgba(0,0,0,0.4); color:#fff; font-size:18px; cursor:pointer;';
      next.onclick = (e) => { e.stopPropagation(); show(idx + 1); };
      box.appendChild(prev);
      box.appendChild(next);
      timer = setInterval(() => show(idx + 1), interval);
    }

    overlay.onclick = () => close();
    box.onclick = (e) => e.stopPropagation();

    overlay.appendChild(box);
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
  };

  function renderTextBlock(block, root) {
    const st = block.style || {};
    const wrapper = document.createElement('div');
    wrapper.style.textAlign = st.align || 'center';
    wrapper.style.marginTop = `${st.mt ?? 16}px`;
    wrapper.style.marginBottom = `${st.mb ?? 16}px`;
    const inner = document.createElement('div');
    inner.style.fontSize = `${st.fontSize || 18}px`;
    inner.style.fontWeight = st.fontWeight || 'normal';
    inner.style.color = st.color || '#333';
    inner.innerHTML = escapeHtml(block.text || '').replace(/\n/g, '<br/>');
    wrapper.appendChild(inner);
    root.appendChild(wrapper);
  }

  // 이벤트 유의사항 — 이미지 자체가 클릭 트리거.
  // 이미지 클릭 시 하단에 본문 텍스트가 슬라이드 다운으로 나타남.
  // 이미지는 일반 image 블록과 동일한 레이아웃 (간격/라운드 없이 화면 가득).
  function renderEventNoticeBlock(block, root) {
    const title = block.noticeTitle || '이벤트 유의사항';
    const noticeImg = block.noticeImage || '';
    const noticeText = block.noticeText || '';
    if (!noticeImg && !noticeText) return;

    const wrap = document.createElement('div');
    wrap.style.cssText = `position:relative; margin:0 auto; width:100%; max-width:${pageMaxWidth}px; font-size:0; font-family:"Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,sans-serif;`;

    let trigger;
    if (noticeImg) {
      // 이미지를 트리거로 — 일반 image 블록과 똑같은 외관 (간격/라운드/배경 없음)
      trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.style.cssText = 'width:100%; padding:0; margin:0; border:0; background:transparent; cursor:pointer; display:block; font-size:0;';
      trigger.setAttribute('aria-label', title);
      const img = document.createElement('img');
      img.src = noticeImg;
      img.alt = title;
      img.style.cssText = 'max-width:100%; height:auto; display:block; margin:0 auto;';
      trigger.appendChild(img);
    } else {
      // 이미지 없으면 텍스트 버튼 폴백
      trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.style.cssText = 'width:100%; padding:16px 20px; background:#f5f5f5; border:1px solid #e0e0e0; border-radius:6px; font-size:15px; font-weight:600; color:#333; cursor:pointer; display:flex; justify-content:space-between; align-items:center; text-align:left; margin:24px 0;';
      trigger.innerHTML = `<span>${escapeHtml(title)}</span><span class="evt-notice-caret" style="transition:transform 0.3s ease; font-size:12px;">▾</span>`;
    }

    const panel = document.createElement('div');
    panel.style.cssText = 'overflow:hidden; max-height:0; transition:max-height 0.4s ease;';

    // 본문 영역 스타일 — admin 에서 지정한 값 우선, 없으면 기본값.
    const ns = block.noticeStyle || {};
    const padding = (typeof ns.padding === 'number') ? ns.padding : 16;
    const bg = ns.background || 'transparent';
    const color = ns.color || '#444';
    const fontSize = (typeof ns.fontSize === 'number') ? ns.fontSize : 14;
    const lineHeight = (typeof ns.lineHeight === 'number') ? ns.lineHeight : 1.7;
    const letterSpacing = (typeof ns.letterSpacing === 'number') ? `${ns.letterSpacing}px` : '0';

    const inner = document.createElement('div');
    inner.style.cssText = `padding:${padding}px; background:${bg}; font-size:${fontSize}px; color:${color}; line-height:${lineHeight}; letter-spacing:${letterSpacing}; white-space:pre-wrap;`;
    inner.textContent = noticeText || '';
    panel.appendChild(inner);

    let open = false;
    trigger.addEventListener('click', () => {
      open = !open;
      const caret = trigger.querySelector('.evt-notice-caret');
      if (open) {
        panel.style.maxHeight = inner.scrollHeight + 32 + 'px';
        if (caret) caret.style.transform = 'rotate(180deg)';
      } else {
        panel.style.maxHeight = '0';
        if (caret) caret.style.transform = 'rotate(0deg)';
      }
    });

    wrap.appendChild(trigger);
    if (noticeText) wrap.appendChild(panel);
    root.appendChild(wrap);
  }

  function renderVideoBlock(block, root) {
    const ratio = block.ratio || { w: 16, h: 9 };
    if (!block.youtubeId) return;
    const src = buildYouTubeSrc(block.youtubeId, toBool(block.autoplay), toBool(block.loop));
    const wrap = document.createElement('div');
    wrap.style.cssText = `position:relative; width:100%; max-width:${pageMaxWidth}px; margin:16px auto; aspect-ratio:${ratio.w}/${ratio.h};`;
    const iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.title = `youtube-${block.youtubeId}`;
    iframe.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; border:0;';
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
    iframe.setAttribute('allowfullscreen', '');
    wrap.appendChild(iframe);
    root.appendChild(wrap);
  }

  function renderProductBlock(block, root) {
    const groupWrapper = document.createElement('div');
    groupWrapper.className = 'product-group-wrapper';

    if (block.layoutType === 'tabs') {
      const activeColor = block.activeColor || '#1890ff';
      // 콘텐츠 너비 모드: default(800px 가운데) | wide(95% 가운데) | full(100% 꽉 채움)
      const widthMode = block.tabWidthMode || 'default';
      const tabsContainer = document.createElement('div');
      tabsContainer.className = `tabs_${pageId}`;
      // tabsPerRow 가 2 이상이면 grid 로 줄바꿈 (인라인 스타일이 .tabs_${pageId} 의 display:flex 를 덮어씀)
      if (block.tabsPerRow && Number(block.tabsPerRow) >= 2) {
        const n = Number(block.tabsPerRow);
        tabsContainer.style.display = 'grid';
        tabsContainer.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
      }
      // 탭 버튼 줄 너비도 콘텐츠 너비에 맞춰 확장 (기본 CSS 의 max-width:800px 오버라이드)
      if (widthMode === 'wide') { tabsContainer.style.maxWidth = '95%'; tabsContainer.style.width = '95%'; }
      else if (widthMode === 'full') { tabsContainer.style.maxWidth = '100%'; tabsContainer.style.width = '100%'; }
      else { tabsContainer.style.maxWidth = `${pageMaxWidth}px`; }
      (block.tabs || []).forEach((t, i) => {
        const btn = document.createElement('button');
        if (i === 0) {
          btn.className = 'active';
          btn.style.backgroundColor = activeColor;
          btn.style.color = '#fff';
          btn.style.borderColor = activeColor;
        }
        btn.onclick = () => window.showTab(`${block.id || pageId}-tab-${i}`, btn, activeColor);
        btn.textContent = t.title || `탭 ${i+1}`;
        tabsContainer.appendChild(btn);
      });
      groupWrapper.appendChild(tabsContainer);

      (block.tabs || []).forEach((t, i) => {
        const panel = document.createElement('div');
        panel.id = `${block.id || pageId}-tab-${i}`;
        panel.className = `tab-content_${pageId}`;
        panel.style.display = i === 0 ? 'block' : 'none';
        const ul = document.createElement('ul');
        ul.className = `main_Grid_${pageId}`;
        // 탭별 그리드 사이즈 우선, 없으면 block.gridSize 사용.
        ul.dataset.gridSize = (block.tabGridSizes && block.tabGridSizes[i] != null)
          ? block.tabGridSizes[i]
          : block.gridSize;
        ul.dataset.widthMode = widthMode;
        if (block.registerMode === 'direct') {
          const tabDirect = (block.tabDirectProducts?.[i] || []);
          const directNos = tabDirect.map(p => p.product_no).join(',');
          ul.dataset.directNos = directNos;
          try { ul.dataset.savedProducts = JSON.stringify(tabDirect); } catch (e) { /* skip */ }
        } else { ul.dataset.cate = t.sub || t.root; }
        panel.appendChild(ul);
        groupWrapper.appendChild(panel);
      });
    } else {
      const widgetDiv = document.createElement('div');
      widgetDiv.className = 'product_list_widget';
      const ul = document.createElement('ul');
      ul.className = `main_Grid_${pageId}`;
      ul.dataset.gridSize = block.gridSize;
      if (block.registerMode === 'direct') {
        const directNos = (block.directProducts || []).map(p => p.product_no).join(',');
        ul.dataset.directNos = directNos;
        // 저장된 상품 데이터(영문/요약 등) 를 보존 — runtime ychat 응답에 누락된 필드의 fallback 으로 사용.
        try { ul.dataset.savedProducts = JSON.stringify(block.directProducts || []); } catch (e) { /* skip */ }
      } else { ul.dataset.cate = block.sub || block.root; }
      widgetDiv.appendChild(ul);
      groupWrapper.appendChild(widgetDiv);
    }
    root.appendChild(groupWrapper);
  }

  // ────────────────────────────────────────────────────────────────
  // 4) 상품 데이터 로드 (cafe24 ychat 서버에서 fetch)
  // ────────────────────────────────────────────────────────────────
  async function fetchProducts(directNosAttr, category, limit = 300) {
    if (!PRODUCT_API_BASE) return [];
    const fetchOpts = { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } };

    const mapProductData = p => ({
      product_no: p.product_no,
      product_name: p.product_name,
      // cafe24 의 영문 상품명 / 요약 설명 / 브리핑 설명 — #goods_name 영역에 사용.
      // 가장 적합한 값을 우선순위로 fallback.
      eng_product_name: p.eng_product_name || '',
      summary_description: p.summary_description || '',
      simple_description: p.simple_description || '',
      price: p.price,
      list_image: p.list_image,
      image_medium: p.image_medium,
      image_small: p.image_small,
      image_thumbnail: p.tiny_image,
      sale_price: p.sale_price || null,
      benefit_price: p.benefit_price || null,
      benefit_percentage: p.benefit_percentage || null,
      decoration_icon_url: p.decoration_icon_url || null,
      icons: p.icons || null,
      additional_icons: p.additional_icons || [],
      product_tags: p.product_tags || ''
    });

    if (directNosAttr) {
      const ids = directNosAttr.split(',').map(s => s.trim()).filter(Boolean);
      if (ids.length === 0) return [];
      const results = await Promise.all(ids.map(no =>
        fetchWithRetry(`${PRODUCT_API_BASE}/api/${mallId}/products/${no}${couponQSStart()}`, fetchOpts).then(r => r.json())
      ));
      return results.map(p => (p && p.product_no) ? p : {}).map(mapProductData);
    } else if (category) {
      const prodUrl = `${PRODUCT_API_BASE}/api/${mallId}/categories/${category}/products?limit=${limit}${couponQSAppend()}`;
      const rawProducts = await fetchWithRetry(prodUrl, fetchOpts).then(r => r.json()).then(json => Array.isArray(json) ? json : (json.products || []));
      return rawProducts.map(p => (typeof p === 'object' ? p : {})).map(mapProductData);
    }
    return [];
  }

  // 상품 그리드 로드 — 패널 하나당 1회 호출, 한 번에 전체 상품을 불러와 렌더한다.
  // (점진/무한 스크롤 방식은 무한 로딩 이슈로 제거함)
  async function loadPanel(ul) {
    // 중복 로드 방지 — IntersectionObserver 와 showTab 양쪽에서 호출될 수 있음.
    if (!ul || ul.dataset.loaded === '1' || ul.dataset.loading === '1') return;
    ul.dataset.loading = '1';
    const cols = parseInt(ul.dataset.gridSize, 10) || 2;

    // savedProducts(저장 시점 값) 맵 — direct 모드 누락 필드 fallback.
    let savedMap = {};
    if (ul.dataset.savedProducts) {
      try { (JSON.parse(ul.dataset.savedProducts) || []).forEach(p => { if (p && p.product_no != null) savedMap[String(p.product_no)] = p; }); }
      catch (e) { /* skip */ }
    }

    let spinner = null;
    const spinnerTimer = setTimeout(() => {
      spinner = document.createElement('div');
      spinner.className = 'grid-spinner';
      if (ul.parentNode) ul.parentNode.insertBefore(spinner, ul);
    }, 2000);

    try {
      const products = await fetchProducts(ul.dataset.directNos, ul.dataset.cate);
      renderProducts(ul, mergeSavedProducts(products, savedMap), cols);
      ul.dataset.loaded = '1';
    } catch (err) {
      console.error('상품 로드 실패:', err);
      showLoadError(ul);
    } finally {
      clearTimeout(spinnerTimer);
      if (spinner) spinner.remove();
      ul.dataset.loading = '';
    }
  }

  // 자체 클래스로 상품 카드 렌더 — 자사몰 /css/goodsData.html 의존성 제거.
  // 디자인은 사이트 라이브 카드와 일치시킴.
  //   .prd_link        : 이미지+영문/요약+상품명 까지 묶는 a 태그
  //   .prd_thumb       : 이미지 영역 (정사각형, 둥근 모서리)
  //   .prd_iconsData   : 이미지 위 좌측 상단 데코 아이콘/배지 (Premium / NEW / BEST / SALE 등)
  //   .prd_desc        : 영문/요약 (민트/청록색 — 디자인 매칭)
  //   .prd_name        : 상품명 (굵게)
  //   .prd_price       : 가격 영역 (10% 뱃지 + 정가 취소선 + 최종가)
  // 그리드 컨테이너 스타일 (콘텐츠 너비 모드 반영). safeCols 반환.
  function applyGridStyle(ul, cols) {
    const safeCols = Math.max(1, Math.min(4, parseInt(cols, 10) || 2));
    const maxWidth = safeCols === 1 ? 400 : pageMaxWidth;
    const widthMode = ul.dataset.widthMode || 'default';
    let widthCss;
    if (widthMode === 'wide') widthCss = 'width:95%; max-width:95%; margin:24px auto;';
    else if (widthMode === 'full') widthCss = 'width:100%; max-width:100%; margin:24px 0;';
    else widthCss = `max-width:${maxWidth}px; margin:24px auto;`;
    ul.style.cssText = `display:grid; grid-template-columns:repeat(${safeCols},1fr); gap:24px; ${widthCss} list-style:none; padding:0;`;
    return safeCols;
  }

  // 상품 배열 → 카드 HTML 문자열.
  function buildProductCardsHtml(products) {
    const formatKRW = val => `${(Number(val) || 0).toLocaleString('ko-KR')}원`;
    const parseNumber = v => {
      if (v == null) return null;
      if (typeof v === 'number' && isFinite(v)) return v;
      const n = parseFloat(String(v).replace(/[^\d.-]/g, ''));
      return isFinite(n) ? n : null;
    };

    return (products || []).map(p => {
      const origPrice = parseNumber(p.price) || 0;
      const salePrice = parseNumber(p.sale_price);
      const benefitPrice = parseNumber(p.benefit_price);
      const isSale = salePrice != null && salePrice < origPrice;
      const isCoupon = benefitPrice != null && benefitPrice < (isSale ? salePrice : origPrice);

      let displayPercent = null;
      if (isCoupon) {
        const base = isSale ? salePrice : origPrice;
        if (base > 0 && benefitPrice >= 0) {
          displayPercent = Math.round((base - benefitPrice) / base * 100);
        }
      } else if (isSale && origPrice > 0) {
        displayPercent = Math.round((origPrice - salePrice) / origPrice * 100);
      }

      const priceText = formatKRW(origPrice);
      const finalPrice = isCoupon ? formatKRW(benefitPrice) : isSale ? formatKRW(salePrice) : priceText;
      // 정가가 표시될 조건: 할인 또는 쿠폰이 적용된 경우
      const showOriginal = isSale || isCoupon;

      const initialImg = p.image_medium || p.list_image;
      const hoverImg = p.image_thumbnail || p.image_small;
      const productLink = `/product/detail.html?product_no=${p.product_no}`;
      const hoverAttrs = hoverImg && initialImg && hoverImg !== initialImg
        ? `onmouseover="this.src='${hoverImg}'" onmouseout="this.src='${initialImg}'"` : '';

      // 이미지 좌상단 데코 아이콘/뱃지 — cafe24 decoration_icon_url, additional_icons, icons (NEW/BEST/SALE)
      let iconHtml = '';
      const renderedUrls = new Set();
      if (p.decoration_icon_url && !renderedUrls.has(p.decoration_icon_url)) {
        iconHtml += `<img src="${p.decoration_icon_url}" alt="icon" />`;
        renderedUrls.add(p.decoration_icon_url);
      }
      if (Array.isArray(p.additional_icons)) {
        p.additional_icons.forEach(icon => {
          if (icon && icon.icon_url && !renderedUrls.has(icon.icon_url)) {
            iconHtml += `<img src="${icon.icon_url}" alt="${escapeHtml(icon.icon_alt || '아이콘')}" />`;
            renderedUrls.add(icon.icon_url);
          }
        });
      }
      if (p.icons && typeof p.icons === 'object') {
        ['icon_new', 'icon_recom', 'icon_best', 'icon_sale'].forEach(key => {
          const url = p.icons[key];
          if (url && !renderedUrls.has(url)) {
            iconHtml += `<img src="${url}" alt="${key.replace('icon_', '')}" />`;
            renderedUrls.add(url);
          }
        });
      }

      // 영문 상품명 → 요약설명 → 브리핑설명 순으로 fallback (이름 위 민트색 텍스트)
      const subText = p.eng_product_name || p.summary_description || p.simple_description || '';

      const percentText = displayPercent && displayPercent > 0 ? `${displayPercent}%` : '';
      return `
        <li>
          <a href="${productLink}" class="prd_link" data-track-click="product" data-product-no="${p.product_no}" target="_blank" rel="noopener noreferrer">
            <div class="prd_thumb">
              ${initialImg ? `<img src="${initialImg}" ${hoverAttrs} loading="lazy" alt="${escapeHtml(p.product_name || '')}" />` : ''}
              ${iconHtml ? `<div class="prd_iconsData">${iconHtml}</div>` : ''}
              ${percentText ? `<span class="prd_percent_overlay">${percentText}</span>` : ''}
              ${p.sold_out === 'T' ? `<div class="prd_sold_out_overlay">SOLD OUT</div>` : ''}
            </div>
            ${subText ? `<div class="prd_desc">${escapeHtml(subText)}</div>` : ''}
            <div class="prd_name">${escapeHtml(p.product_name || '')}</div>
          </a>
          <div class="prd_price">
            ${percentText ? `<span class="prd_percent">${percentText}</span>` : ''}
            ${showOriginal ? `<span class="prd_original">${priceText}</span>` : ''}
            <span class="prd_final">${finalPrice}</span>
          </div>
        </li>`;
    }).join('');
  }

  // hover 이미지 미리 로드 — 마우스를 올리는 순간 새로 받아오며 깜빡이는(빤짝) 현상 방지.
  function preloadHoverImgs(products) {
    (products || []).forEach(p => {
      const hoverImg = p.image_thumbnail || p.image_small;
      const baseImg = p.image_medium || p.list_image;
      if (hoverImg && baseImg && hoverImg !== baseImg) {
        const pre = new Image();
        pre.src = hoverImg;
      }
    });
  }

  // 전체 교체 렌더 (단건/폴백). 1×1 은 1개만 노출.
  function renderProducts(ul, products, cols) {
    const safeCols = applyGridStyle(ul, cols);
    const list = safeCols === 1 ? (products || []).slice(0, 1) : (products || []);
    ul.innerHTML = buildProductCardsHtml(list);
    preloadHoverImgs(list);
  }

  // savedProducts(저장 시점 값) 를 fresh 데이터에 병합 — 누락 필드 fallback.
  function mergeSavedProducts(products, savedMap) {
    return (products || []).map(p => {
      const saved = (savedMap && savedMap[String(p.product_no)]) || {};
      return {
        ...p,
        summary_description: p.summary_description || saved.summary_description || '',
        eng_product_name: p.eng_product_name || saved.eng_product_name || '',
        simple_description: p.simple_description || saved.simple_description || '',
        list_image: p.list_image || saved.list_image || '',
        image_medium: p.image_medium || saved.image_medium || '',
        product_name: p.product_name || saved.product_name || '',
      };
    });
  }

  function showLoadError(ul) {
    if (ul.parentNode) {
      const errDiv = document.createElement('div');
      errDiv.style.textAlign = 'center';
      errDiv.style.padding = '50px 0';
      errDiv.innerHTML = `<p style="color:#666; font-size:14px; margin: 0;">상품 정보를 불러올 수 없습니다.</p>`;
      ul.parentNode.insertBefore(errDiv, ul);
    }
  }

  // 스피너/탭만 위젯 자체에서 책임. 상품 카드 디자인은 자사몰 /css/goodsData.html 에 위임.
  // 단, 가격 영역(.goods_price)이 goodsData.html 에 없을 가능성에 대비해 최소 fallback 스타일만 인라인 제공.
  const style = document.createElement('style');
  style.textContent = `
    .grid-spinner { width: 40px; height: 40px; border: 4px solid #f3f3f3; border-top: 4px solid #1890ff; border-radius: 50%; animation: spin_${pageId} 1s linear infinite; margin: 20px auto; }
    @keyframes spin_${pageId} { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg);} }
    .tabs_${pageId} { display: flex; gap: 8px; max-width: 800px; margin: 16px auto; }
    .tabs_${pageId} button { flex: 1; padding: 8px; font-size: 16px; border: 1px solid #d9d9d9; background: #f5f5f5; color: #333; cursor: pointer; border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tabs_${pageId} button.active { font-weight: 600; }

    /* === 상품 카드 — 사이트 라이브 디자인 매칭 (사장님 지정 스펙) === */
    .main_Grid_${pageId} li { list-style: none; }
    .main_Grid_${pageId} .prd_link { display: block; text-decoration: none; color: inherit; }
    /* 이미지 영역 — 둥근 모서리 + 데코 아이콘 absolute 컨테이너 */
    .main_Grid_${pageId} .prd_thumb {
      position: relative;
      aspect-ratio: 1 / 1;
      background: #f8f9fa;
      overflow: hidden;
      border-radius: 12px;
    }
    .main_Grid_${pageId} .prd_thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    /* 품절 오버레이 — sold_out === 'T' 인 상품의 썸네일을 반투명 회색으로 덮고 "품절" 텍스트 중앙 노출 */
    .main_Grid_${pageId} .prd_sold_out_overlay {
      position: absolute; inset: 0; background: rgba(0,0,0,0.45);
      color: #fff; display: flex; align-items: center; justify-content: center;
      font-size: 22px; font-weight: 700; letter-spacing: 3px;
      border-radius: 12px; pointer-events: none; z-index: 3;
      font-family: "Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, sans-serif;
    }
    /* 이미지 우하단 데코 아이콘 (Premium / NEW / BEST / SALE / 커스텀 등).
       썸네일 오른쪽 아래 모서리. 폭은 최대 40px, 비율 유지. */
    .main_Grid_${pageId} .prd_iconsData {
      position: absolute;
      bottom: 12px;
      right: 12px;
      display: flex;
      gap: 4px;
      z-index: 2;
      pointer-events: none;
    }
    .main_Grid_${pageId} .prd_iconsData img {
      width: 100%;
      max-width: 40px;
      height: auto;
      display: block;
    }
    /* 영문 상품명(요약) — #goods_name */
    .main_Grid_${pageId} .prd_desc {
      font-size: 11px;
      color: #ABB0BA;
      margin-top: 12px;
      line-height: 1.3;
      letter-spacing: -0.03em;
    }
    /* 한글 상품명 — .name */
    .main_Grid_${pageId} .prd_name {
      display: inline-block;
      font-size: 16px;
      color: #090909;
      font-weight: 400;
      margin-top: 5px;
      line-height: 1.3;
      letter-spacing: -0.03em;
      width: 100%;
    }
    /* 가격 영역 — 쿠폰 적용 시 2줄 구성
       (1) 정가(취소선) 한 줄 차지, 우측 정렬
       (2) 10% 뱃지(좌) + 최종가(우) */
    .main_Grid_${pageId} .prd_price {
      display: flex;
      align-items: center;
      margin-top: 10px;
      flex-wrap: wrap;
    }
    .main_Grid_${pageId} .prd_original {
      order: 1;
      width: 100%;
      text-align: right;
      color: #CACFD8;
      font-size: 10px;
      font-weight: 400;
      letter-spacing: 0;
      text-decoration: line-through;
      margin-top: 5px;
    }
    .main_Grid_${pageId} .prd_percent {
      order: 2;
      background: #06BEDE;
      color: #fff;
      width: 48px;
      height: 20px;
      line-height: 20px;
      text-align: center;
      font-weight: 700;
      font-size: 13px;
      border-radius: 50px;
      float: none;
    }
    .main_Grid_${pageId} .prd_final {
      order: 3;
      margin-left: auto;
      font-size: 16px;
      font-weight: 400;
      color: #090909;
    }

    /* 이미지 좌상단 % 뱃지 오버레이 — 기본은 숨김. 모바일 + 3-col 일 때만 노출. */
    .main_Grid_${pageId} .prd_percent_overlay { display: none; }

    /* === 모바일 (≤500px) + 3-col 레이아웃 ===
       - 카드 간격 좁힘 / 상품명 폰트 축소
       - 가격 영역 뱃지 숨김 → 이미지 좌상단 코너 오버레이 뱃지로 노출 (모서리 붙음 + 우하단만 라운드)
       - 최종가 좌측 정렬 */
    @media (max-width: 500px) {
      .main_Grid_${pageId}[data-grid-size="3"] {
        /* renderProducts 가 ul.style.gap 을 인라인으로 24px 박아두므로 !important 로 오버라이드 */
        gap: 10px !important;
      }
      .main_Grid_${pageId}[data-grid-size="3"] .prd_name {
        font-size: 13px;
      }
      .main_Grid_${pageId}[data-grid-size="3"] .prd_percent {
        display: none;
      }
      .main_Grid_${pageId}[data-grid-size="3"] .prd_percent_overlay {
        display: block;
        position: absolute;
        top: 0;
        left: 0;
        z-index: 3;
        background: #06BEDE;
        color: #fff;
        width: 46px;
        height: 18px;
        line-height: 18px;
        text-align: center;
        font-weight: 700;
        font-size: 12px;
        border-radius: 0;
        border-bottom-right-radius: 10px;
      }
      .main_Grid_${pageId}[data-grid-size="3"] .prd_final {
        order: 2;
        margin-left: auto;
        font-size: 14px;
        font-weight: 400;
        color: #090909;
        width: 100%;
        text-align: right;
      }
    }

    @media (max-width: 400px) {
      .main_Grid_${pageId} { width: 96%; margin: 0 auto; }
      .main_Grid_${pageId} .prd_iconsData { bottom: 8px; right: 8px; }
      .main_Grid_${pageId} .prd_iconsData img { max-width: 36px; }
    }
  `;
  document.head.appendChild(style);

  // ────────────────────────────────────────────────────────────────
  // 5) 이벤트 데이터 로드 (이 앱 서버: /api/events/{pageId})
  // ────────────────────────────────────────────────────────────────
  async function initializePage() {
    try {
      if (!SELF_BASE) {
        console.error('widget.js: SELF_BASE 추출 실패');
        return;
      }
      // ychat 의 실제 라우트는 `/api/{mallId}/events/{id}`. eventTemp 의 `/api/events/{id}` 도 함께 폴백.
      // cloudtype cold start / 일시적 5xx / 네트워크 흔들림으로 한 번 실패하면 즉시
      // "이벤트를 불러올 수 없습니다" 가 떠버리는 문제를 막기 위해 자동 재시도(3회, 백오프)한다.
      const _eventUrls = [
        `${SELF_BASE}/api/${encodeURIComponent(mallId)}/events/${pageId}`,
        `${SELF_BASE}/api/events/${pageId}?mallId=${encodeURIComponent(mallId)}`,
      ];
      const _retryDelays = [0, 1200, 2500];
      let response = null, _lastErr = null;
      for (let attempt = 0; attempt < _retryDelays.length && !response; attempt++) {
        if (_retryDelays[attempt]) await new Promise(r => setTimeout(r, _retryDelays[attempt]));
        for (const url of _eventUrls) {
          try {
            const res = await fetch(url, { cache: 'no-store' });
            if (res.ok) { response = res; break; }
            _lastErr = new Error('HTTP ' + res.status);
          } catch (e) { _lastErr = e; }
        }
      }
      if (!response) throw _lastErr || new Error('Event data fetch failed');
      const json = await response.json();
      // 우리 서버 응답 형태: { success, data }
      const ev = json && json.data ? json.data : json;

      // 이벤트 데이터에 couponNos 가 있으면 script 태그의 data-coupon-nos 를 덮어쓴다.
      // 이 덕에 admin 의 이벤트 편집만으로 라이브 쿠폰이 실시간 반영됨 — HTML 재배포 불필요.
      if (Array.isArray(ev.couponNos)) {
        couponNos = ev.couponNos.map(String).filter(Boolean).join(',');
      }
      // 페이지 전체 최대 너비 — admin 에서 지정한 값이 있으면 사용 (없으면 기본 800).
      if (Number(ev.pageMaxWidth) > 0) {
        pageMaxWidth = Number(ev.pageMaxWidth);
      }

      const root = getRootContainer();

      // sections 우선, 없으면 legacy content.blocks/images 로 fallback
      const blocks = Array.isArray(ev.sections) && ev.sections.length > 0
        ? ev.sections
        : (ev.content && Array.isArray(ev.content.blocks))
          ? ev.content.blocks
          : (ev.images || []).map(img => ({ type: 'image', ...img }));

      blocks.forEach(block => {
        switch (block.type) {
          case 'image': renderImageBlock(block, root); break;
          case 'video': renderVideoBlock(block, root); break;
          case 'text': renderTextBlock(block, root); break;
          case 'product_group': renderProductBlock(block, root); break;
          case 'event_notice': renderEventNoticeBlock(block, root); break;
          default: break;
        }
      });

      // 상품 그리드는 한꺼번에 불러오지 않고, 뷰포트에 가까워질 때만 지연 로드한다.
      // → 첫 화면에서 배너 이미지가 상품 데이터 fetch 와 경쟁하지 않고 먼저 빠르게 뜨고,
      //   화면 밖/숨겨진 탭의 상품은 필요할 때만 요청 → 동시 호출 폭주(500) 완화.
      const grids = document.querySelectorAll(`ul.main_Grid_${pageId}`);
      if ('IntersectionObserver' in window) {
        const gridObserver = new IntersectionObserver((entries, obs) => {
          entries.forEach(entry => {
            if (entry.isIntersecting) {
              obs.unobserve(entry.target);
              loadPanel(entry.target);
            }
          });
        }, { rootMargin: '300px 0px' });
        grids.forEach(ul => gridObserver.observe(ul));
      } else {
        grids.forEach(ul => loadPanel(ul));
      }

      // URL 진입 시 특정 탭 자동 활성화 — ?tabN 형식 (1-based, 첫 탭 블록의 N번째 탭).
      // 예: /event.html?tab2 → 첫 상품 탭 블록의 2번째 탭이 열린 상태로 진입 + 그 영역으로 스크롤.
      try {
        let matchedN = null;
        for (const key of new URLSearchParams(location.search).keys()) {
          const m = key.match(/^tab(\d+)$/i);
          if (m) { matchedN = parseInt(m[1], 10); break; }
        }
        if (matchedN && matchedN >= 1) {
          const containers = document.querySelectorAll('.tabs_' + pageId);
          const target = containers.length ? containers[0].querySelectorAll('button')[matchedN - 1] : null;
          if (target) {
            target.click();
            setTimeout(() => { try { containers[0].scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) {} }, 60);
          }
        }
      } catch (_) { /* URL 파싱 실패는 무시 */ }
    } catch (err) {
      console.error('EVENT LOAD ERROR', err);
      const root = getRootContainer();
      root.innerHTML = `<div style="text-align:center; padding:60px 20px; color:#999; font-size:14px;">이벤트를 불러올 수 없습니다.</div>`;
    }
  }

  window.showTab = (id, btn, activeColor = '#1890ff') => {
    const parent = btn.closest('.tabs_' + pageId);
    if (!parent) return;
    parent.querySelectorAll('button').forEach(b => {
      b.classList.remove('active');
      b.style.backgroundColor = '#f5f5f5';
      b.style.color = '#333';
      b.style.borderColor = '#d9d9d9';
    });
    btn.classList.add('active');
    btn.style.backgroundColor = activeColor;
    btn.style.color = '#fff';
    btn.style.borderColor = activeColor;
    const contentParent = parent.parentElement;
    contentParent.querySelectorAll('.tab-content_' + pageId).forEach(el => {
      if (el.id === id) {
        el.style.display = 'block';
        // 지연 로딩: 탭이 처음 열릴 때 그 탭의 상품만 로드 (이미 로드됐으면 no-op).
        const ul = el.querySelector('ul.main_Grid_' + pageId);
        if (ul) loadPanel(ul);
      } else { el.style.display = 'none'; }
    });
  };

  // 쿠폰 다운로드: 다중 쿠폰을 한 창에서 한꺼번에 발급.
  // - 콤마 구분 문자열 또는 배열 모두 허용
  // - cafe24 IssueDownload 는 coupon_no 에 "콤마 구분 단일 파라미터"(coupon_no=A,B,C) 형식으로
  //   여러 쿠폰을 한 번에 발급한다. 반복 파라미터(coupon_no=A&coupon_no=B)는 마지막 1개만 적용되므로 금지.
  window.downloadCoupon = (coupons) => {
    const list = Array.isArray(coupons)
      ? coupons.map(s => String(s).trim()).filter(Boolean)
      : String(coupons || '').split(',').map(s => s.trim()).filter(Boolean);
    if (list.length === 0) { alert('쿠폰 정보가 없습니다.'); return; }
    // 쿠폰 번호는 숫자라 콤마 그대로 안전. 인코딩하면 %2C 로 바뀌어 분리 실패할 수 있어 콤마는 그대로 둔다.
    const url = `/exec/front/newcoupon/IssueDownload?coupon_no=${list.join(',')}&opener_url=${encodeURIComponent(location.href)}`;
    window.open(url, '_blank');
  };

  initializePage();
})();
