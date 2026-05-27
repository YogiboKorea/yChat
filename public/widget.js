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
    wrap.style.cssText = 'position:relative; margin:0 auto; width:100%; max-width:800px; font-size:0;';
    const img = document.createElement('img');
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

  // 이벤트 유의사항 — 토글 버튼 + 슬라이드 다운으로 펼쳐지는 콘텐츠 (이미지 + 본문).
  // 초기 상태 collapsed. 클릭 시 max-height 트랜지션으로 부드럽게 펼침/접힘.
  function renderEventNoticeBlock(block, root) {
    const title = block.noticeTitle || '이벤트 유의사항';
    const noticeImg = block.noticeImage || '';
    const noticeText = block.noticeText || '';
    if (!noticeImg && !noticeText) return;

    const wrap = document.createElement('div');
    wrap.style.cssText = 'max-width:800px; margin:24px auto; font-family:"Pretendard Variable",Pretendard,-apple-system,BlinkMacSystemFont,sans-serif;';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.style.cssText = 'width:100%; padding:16px 20px; background:#f5f5f5; border:1px solid #e0e0e0; border-radius:6px; font-size:15px; font-weight:600; color:#333; cursor:pointer; display:flex; justify-content:space-between; align-items:center; text-align:left;';
    btn.innerHTML = `<span>${escapeHtml(title)}</span><span class="evt-notice-caret" style="transition:transform 0.3s ease; font-size:12px;">▾</span>`;

    const panel = document.createElement('div');
    panel.style.cssText = 'overflow:hidden; max-height:0; transition:max-height 0.4s ease; border-radius:0 0 6px 6px;';

    const inner = document.createElement('div');
    inner.style.cssText = 'padding:16px 20px; background:#fafafa; border:1px solid #e0e0e0; border-top:none;';
    if (noticeImg) {
      const img = document.createElement('img');
      img.src = noticeImg;
      img.alt = title;
      img.style.cssText = 'max-width:100%; display:block; border-radius:4px;' + (noticeText ? 'margin-bottom:14px;' : '');
      inner.appendChild(img);
    }
    if (noticeText) {
      const txt = document.createElement('div');
      txt.style.cssText = 'font-size:14px; color:#444; line-height:1.7; white-space:pre-wrap;';
      txt.textContent = noticeText;
      inner.appendChild(txt);
    }
    panel.appendChild(inner);

    let open = false;
    btn.addEventListener('click', () => {
      open = !open;
      const caret = btn.querySelector('.evt-notice-caret');
      if (open) {
        panel.style.maxHeight = inner.scrollHeight + 32 + 'px';
        if (caret) caret.style.transform = 'rotate(180deg)';
      } else {
        panel.style.maxHeight = '0';
        if (caret) caret.style.transform = 'rotate(0deg)';
      }
    });

    wrap.appendChild(btn);
    wrap.appendChild(panel);
    root.appendChild(wrap);
  }

  function renderVideoBlock(block, root) {
    const ratio = block.ratio || { w: 16, h: 9 };
    if (!block.youtubeId) return;
    const src = buildYouTubeSrc(block.youtubeId, toBool(block.autoplay), toBool(block.loop));
    const wrap = document.createElement('div');
    wrap.style.cssText = `position:relative; width:100%; max-width:800px; margin:16px auto; aspect-ratio:${ratio.w}/${ratio.h};`;
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
      const tabsContainer = document.createElement('div');
      tabsContainer.className = `tabs_${pageId}`;
      // tabsPerRow 가 2 이상이면 grid 로 줄바꿈 (인라인 스타일이 .tabs_${pageId} 의 display:flex 를 덮어씀)
      if (block.tabsPerRow && Number(block.tabsPerRow) >= 2) {
        const n = Number(block.tabsPerRow);
        tabsContainer.style.display = 'grid';
        tabsContainer.style.gridTemplateColumns = `repeat(${n}, 1fr)`;
      }
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

  async function loadPanel(ul) {
    const cols = parseInt(ul.dataset.gridSize, 10) || 2;
    let spinner = null;

    const spinnerTimer = setTimeout(() => {
      spinner = document.createElement('div');
      spinner.className = 'grid-spinner';
      if (ul.parentNode) ul.parentNode.insertBefore(spinner, ul);
    }, 2000);

    try {
      const products = await fetchProducts(ul.dataset.directNos, ul.dataset.cate, ul.dataset.count);
      // runtime ychat 응답에서 summary_description / eng_product_name 등이 누락되는 경우를 대비해
      // 저장 시점의 directProducts 값을 fallback 으로 병합 (가격/할인 정보는 fresh 데이터를 우선).
      let savedMap = {};
      if (ul.dataset.savedProducts) {
        try {
          const saved = JSON.parse(ul.dataset.savedProducts);
          (saved || []).forEach(p => { if (p && p.product_no != null) savedMap[String(p.product_no)] = p; });
        } catch (e) { /* skip */ }
      }
      const merged = products.map(p => {
        const saved = savedMap[String(p.product_no)] || {};
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
      renderProducts(ul, merged, cols);
    } catch (err) {
      console.error('상품 로드 실패:', err);
      if (ul.parentNode) {
        const errDiv = document.createElement('div');
        errDiv.style.textAlign = 'center';
        errDiv.style.padding = '50px 0';
        errDiv.innerHTML = `<p style="color:#666; font-size:14px; margin: 0;">상품 정보를 불러올 수 없습니다.</p>`;
        ul.parentNode.insertBefore(errDiv, ul);
      }
    } finally {
      clearTimeout(spinnerTimer);
      if (spinner) spinner.remove();
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
  function renderProducts(ul, products, cols) {
    const safeCols = Math.max(1, Math.min(4, parseInt(cols, 10) || 2));
    // 1×1 은 단일 상품만 중앙에 좁게 노출
    const maxWidth = safeCols === 1 ? 400 : 800;
    products = safeCols === 1 ? (products || []).slice(0, 1) : (products || []);
    ul.style.cssText = `display:grid; grid-template-columns:repeat(${safeCols},1fr); gap:24px; max-width:${maxWidth}px; margin:24px auto; list-style:none; padding:0;`;

    const formatKRW = val => `${(Number(val) || 0).toLocaleString('ko-KR')}원`;
    const parseNumber = v => {
      if (v == null) return null;
      if (typeof v === 'number' && isFinite(v)) return v;
      const n = parseFloat(String(v).replace(/[^\d.-]/g, ''));
      return isFinite(n) ? n : null;
    };

    ul.innerHTML = products.map(p => {
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
              ${initialImg ? `<img src="${initialImg}" ${hoverAttrs} alt="${escapeHtml(p.product_name || '')}" />` : ''}
              ${iconHtml ? `<div class="prd_iconsData">${iconHtml}</div>` : ''}
              ${percentText ? `<span class="prd_percent_overlay">${percentText}</span>` : ''}
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
      let response = await fetch(`${SELF_BASE}/api/${encodeURIComponent(mallId)}/events/${pageId}`);
      if (!response.ok) {
        response = await fetch(`${SELF_BASE}/api/events/${pageId}?mallId=${encodeURIComponent(mallId)}`);
      }
      if (!response.ok) throw new Error('Event data fetch failed');
      const json = await response.json();
      // 우리 서버 응답 형태: { success, data }
      const ev = json && json.data ? json.data : json;

      // 이벤트 데이터에 couponNos 가 있으면 script 태그의 data-coupon-nos 를 덮어쓴다.
      // 이 덕에 admin 의 이벤트 편집만으로 라이브 쿠폰이 실시간 반영됨 — HTML 재배포 불필요.
      if (Array.isArray(ev.couponNos)) {
        couponNos = ev.couponNos.map(String).filter(Boolean).join(',');
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

      document.querySelectorAll(`ul.main_Grid_${pageId}`).forEach(ul => loadPanel(ul));
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
      if (el.id === id) { el.style.display = 'block'; }
      else { el.style.display = 'none'; }
    });
  };

  // 원본 widget.js 의 쿠폰 다운로드 로직: 쿠폰별로 window.open 반복.
  // - 콤마 구분 문자열 또는 배열 모두 허용
  // - 다중 쿠폰은 각각 별도 창으로 IssueDownload 호출 (cafe24 표준)
  window.downloadCoupon = (coupons) => {
    const list = Array.isArray(coupons)
      ? coupons.map(s => String(s).trim()).filter(Boolean)
      : String(coupons || '').split(',').map(s => s.trim()).filter(Boolean);
    if (list.length === 0) { alert('쿠폰 정보가 없습니다.'); return; }
    list.forEach(cpn => {
      const url = `/exec/front/newcoupon/IssueDownload?coupon_no=${encodeURIComponent(cpn)}&opener_url=${encodeURIComponent(location.href)}`;
      window.open(url, '_blank');
    });
  };

  initializePage();
})();
