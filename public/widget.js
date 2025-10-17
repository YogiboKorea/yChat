;(function () {
  // ────────────────────────────────────────────────────────────────
  // 0) 스크립트/설정값
  // ────────────────────────────────────────────────────────────────
  let script = document.currentScript;
  if (!script || !script.dataset.pageId) {
    script = Array.from(document.getElementsByTagName('script')).find(s =>
      /widget\.js/.test(s.src) && s.dataset.pageId
    );
  }
  if (!script || !script.dataset.pageId || !script.dataset.mallId) {
    console.warn('⚠️ widget.js: mallId/pageId 누락');
    return;
  }

  const API_BASE = script.dataset.apiBase || '';
  const pageId = script.dataset.pageId;
  const mallId = script.dataset.mallId;
  const tabCount = parseInt(script.dataset.tabCount || '0', 10);
  const activeColor = script.dataset.activeColor || '#1890ff';
  const couponNos = script.dataset.couponNos || '';
  const couponQSStart = couponNos ? `?coupon_no=${couponNos}` : '';
  const couponQSAppend = couponNos ? `&coupon_no=${couponNos}` : '';
  const directNos = script.dataset.directNos || '';
  const ignoreText = script.dataset.ignoreText === '1';
  const autoplayAll = script.dataset.autoplayAll === '1';
  const loopAll = script.dataset.loopAll === '1';

  /* ------------------------------------------------------------------
     COOKIE CLEAR & REFRESH FEATURE
   ------------------------------------------------------------------ */
  function deleteCookie(name) {
    try { document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/;`; } catch (e) {}
    const host = location.hostname || '';
    const parts = host.split('.');
    for (let i = 0; i < parts.length - 0; i++) {
      const domain = '.' + parts.slice(i).join('.');
      try {
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${domain};`;
        document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=${domain.replace(/^\./,'')};`;
      } catch (e) {}
    }
  }

  function clearCookiesAndStorage(prefix = null, clearStorage = false) {
    try {
      const all = document.cookie || '';
      if (all) {
        const pairs = all.split(';').map(s => s.trim()).filter(Boolean);
        pairs.forEach(pair => {
          const eq = pair.indexOf('=');
          const name = eq > -1 ? pair.slice(0, eq).trim() : pair;
          if (!name) return;
          if (prefix) {
            if (name.indexOf(prefix) === 0) deleteCookie(name);
          } else {
            deleteCookie(name);
          }
        });
      }
    } catch (e) {}
    if (clearStorage) {
      try { sessionStorage.clear(); localStorage.clear(); }
      catch (e) {}
    }
  }

  (function cookieClearIfRequested() {
    const shouldClear = script.dataset.clearCookies === '1';
    if (!shouldClear) return;
    const prefix = script.dataset.clearCookiePrefix || null;
    const clearStorage = script.dataset.clearStorage === '1';
    clearCookiesAndStorage(prefix, clearStorage);
  })();
  /* --------------------- END COOKIE CLEAR FEATURE --------------------- */

  // API preconnect
  if (API_BASE) {
    const link = document.createElement('link');
    link.rel = 'preconnect';
    link.href = API_BASE;
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
  }

  // ────────────────────────────────────────────────────────────────
  // 1) 유틸/트래킹
  // ────────────────────────────────────────────────────────────────
  const ua = navigator.userAgent;
  const device = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : 'PC';
  const visitorId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
  const pad = n => String(n).padStart(2, '0');
  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function shouldTrack() {
    if (/[?&]track=true/.test(location.search)) return true;
    const key = `tracked_${pageId}_${visitorId}_${today()}`;
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, '1');
    return true;
  }
  function track(payload) {
    if (!API_BASE) return;
    fetch(`${API_BASE}/api/${mallId}/track`, {
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
  function escapeHtml(s = '') {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function parseYouTubeId(input) {
    if (!input) return null;
    const str = String(input).trim();
    if (/^[\w-]{11}$/.test(str)) return str;
    try {
      const url = new URL(str);
      const host = url.hostname.replace('www.', '');
      if (host === 'youtu.be') return url.pathname.slice(1);
      if (host.includes('youtube.com')) {
        const v = url.searchParams.get('v');
        if (v) return v;
        const m = url.pathname.match(/\/(embed|shorts)\/([\w-]{11})/);
        if (m) return m[2];
      }
    } catch (_) {
      const m = str.match(/src=["']([^"']+)["']/i);
      if (m) return parseYouTubeId(m[1]);
    }
    return null;
  }
  function toBool(v) {
    return v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
  }
  const storagePrefix = `widgetCache_${pageId}_`;
  function makeStorageKey(baseKey) {
    return storagePrefix + baseKey;
  }
  function fetchWithRetry(url, opts = {}, retries = 3, backoff = 1000) {
    return fetch(url, opts).then(res => {
      if (res.status === 429 && retries > 0) {
        return new Promise(r => setTimeout(r, backoff)).then(() => fetchWithRetry(url, opts, retries - 1, backoff * 2));
      }
      if (!res.ok) throw res;
      return res;
    });
  }

  // ────────────────────────────────────────────────────────────────
  // 3) 블록 렌더(텍스트/이미지/영상)
  // ────────────────────────────────────────────────────────────────
  function getRootContainer() {
    let root = document.getElementById('evt-root');
    if (!root) root = document.getElementById('evt-images');
    if (!root) {
      root = document.createElement('div');
      root.id = 'evt-root';
      document.body.insertBefore(root, document.body.firstChild);
    }
    const textDiv = document.getElementById('evt-text');
    if (textDiv) textDiv.innerHTML = '';
    root.innerHTML = '';
    return root;
  }

  function renderBlocks(blocks) {
    const root = getRootContainer();
    blocks.forEach((b) => {
      const type = b.type || 'image';
      if (type === 'text') {
        if (ignoreText) return;
        const st = b.style || {};
        const wrapper = document.createElement('div');
        wrapper.style.textAlign = st.align || 'center';
        wrapper.style.marginTop = `${st.mt ?? 16}px`;
        wrapper.style.marginBottom = `${st.mb ?? 16}px`;
        const inner = document.createElement('div');
        inner.style.fontSize = `${st.fontSize || 18}px`;
        inner.style.fontWeight = st.fontWeight || 'normal';
        inner.style.color = st.color || '#333';
        inner.innerHTML = escapeHtml(b.text || '').replace(/\n/g, '<br/>');
        wrapper.appendChild(inner);
        root.appendChild(wrapper);
        return;
      }
      if (type === 'video') {
        const ratio = b.ratio || { w: 16, h: 9 };
        const yid = b.youtubeId || parseYouTubeId(b.src);
        if (!yid) return;
        const willAutoplay = autoplayAll || toBool(b.autoplay);
        const willLoop = loopAll || toBool(b.loop) || willAutoplay;
        const qs = new URLSearchParams({ autoplay: willAutoplay ? '1' : '0', mute: willAutoplay ? '1' : '0', playsinline: '1', rel: '0', modestbranding: '1' });
        if (willLoop) {
          qs.set('loop', '1');
          qs.set('playlist', yid);
        }
        const src = `https://www.youtube.com/embed/${yid}?${qs.toString()}`;
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative; width:100%; max-width:800px; margin:0 auto;';
        if ('aspectRatio' in wrap.style) {
          wrap.style.aspectRatio = `${ratio.w}/${ratio.h}`;
          const iframe = document.createElement('iframe');
          iframe.src = src;
          iframe.title = `youtube-${yid}`;
          iframe.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; border:0;';
          iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
          iframe.setAttribute('allowfullscreen', '');
          wrap.appendChild(iframe);
          root.appendChild(wrap);
          return;
        }
        const innerBox = document.createElement('div');
        innerBox.style.cssText = `position:relative; width:100%; padding-top:${(ratio.h / ratio.w) * 100}%;`;
        const iframe = document.createElement('iframe');
        iframe.src = src;
        iframe.title = `youtube-${yid}`;
        iframe.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; border:0;';
        iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
        iframe.setAttribute('allowfullscreen', '');
        innerBox.appendChild(iframe);
        wrap.appendChild(innerBox);
        root.appendChild(wrap);
        return;
      }
      // IMAGE
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:relative; margin:0 auto; width:100%; max-width:800px;';
      const img = document.createElement('img');
      img.src = b.src;
      img.style.cssText = 'max-width:100%; height:auto; display:block; margin:0 auto;';
      wrap.appendChild(img);
      (b.regions || []).forEach(r => {
        const l = (r.xRatio * 100).toFixed(2), t = (r.yRatio * 100).toFixed(2), w = (r.wRatio * 100).toFixed(2), h = (r.hRatio * 100).toFixed(2);
        if (r.coupon) {
          const btn = document.createElement('button');
          btn.dataset.trackClick = 'coupon';
          btn.style.cssText = `position:absolute; left:${l}%; top:${t}%; width:${w}%; height:${h}%; border:none; cursor:pointer; opacity:0;`;
          btn.addEventListener('click', () => downloadCoupon(r.coupon));
          wrap.appendChild(btn);
        } else if (r.href) {
          const rawHref = String(r.href || '').trim();
          const isTab = /^#?tab[:\s\-]?\d+$/i.test(rawHref);
          const a = document.createElement('a');
          a.dataset.trackClick = 'url';
          a.style.cssText = `position:absolute; left:${l}%; top:${t}%; width:${w}%; height:${h}%; display:block; text-decoration:none; cursor:pointer;`;
          a.setAttribute('data-href', rawHref);
          if (isTab) {
            a.href = 'javascript:void(0)';
          } else {
            a.href = /^https?:\/\//i.test(rawHref) ? rawHref : `https://${rawHref}`;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
          }
          wrap.appendChild(a);
        }
      });
      root.appendChild(wrap);
    });
  }

  // ────────────────────────────────────────────────────────────────
  // 4) 상품 그리드
  // ────────────────────────────────────────────────────────────────
  
  // ✨✨✨ START: NEW/MODIFIED FUNCTIONS ✨✨✨
  
  // ✅ 1. 상품 데이터를 불러오는 `fetchProducts` 함수를 새로 정의합니다.
  async function fetchProducts(directNosAttr, category, limit = 300) {
    const fetchOpts = { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } };
    const ulDirect = directNosAttr || directNos;

    if (ulDirect) {
      const ids = ulDirect.split(',').map(s => s.trim()).filter(Boolean);
      const results = await Promise.all(ids.map(no =>
        fetchWithRetry(`${API_BASE}/api/${mallId}/products/${no}${couponQSStart}`, fetchOpts).then(r => r.json())
      ));
      // API 응답 구조에 맞게 데이터 정제
      return results.map(p => (p && p.product_no) ? p : {}).map(p => ({
        product_no: p.product_no, product_name: p.product_name, summary_description: p.summary_description || '', price: p.price,
        list_image: p.list_image, sale_price: p.sale_price || null, benefit_price: p.benefit_price || null, benefit_percentage: p.benefit_percentage || null
      }));
    } else if (category) {
      const prodUrl = `${API_BASE}/api/${mallId}/categories/${category}/products?limit=${limit}${couponQSAppend}`;
      const [rawProducts] = await Promise.all([
        fetchWithRetry(prodUrl, fetchOpts).then(r => r.json()).then(json => Array.isArray(json) ? json : (json.products || [])),
      ]);
      // API 응답 구조에 맞게 데이터 정제
      return rawProducts.map(p => (typeof p === 'object' ? p : {})).map(p => ({
        product_no: p.product_no, product_name: p.product_name, summary_description: p.summary_description || '', price: p.price,
        list_image: p.list_image, sale_price: p.sale_price || null, benefit_price: p.benefit_price || null, benefit_percentage: p.benefit_percentage || null
      }));
    }
    return [];
  }

  // ✅ 2. 기존 `loadPanel` 함수를 수정하여 `fetchProducts`를 사용하도록 변경합니다.
  async function loadPanel(ul) {
    const cols = parseInt(ul.dataset.gridSize, 10) || 1;
    const baseCacheKey = ul.dataset.directNos ? `direct_${ul.dataset.directNos}` : (ul.dataset.cate ? `cat_${ul.dataset.cate}` : null);
    if (!baseCacheKey) return;
    const storageKey = makeStorageKey(baseCacheKey);

    const stored = localStorage.getItem(storageKey);
    if (stored) {
      try {
        renderProducts(ul, JSON.parse(stored), cols);
        return; // 캐시가 있으면 바로 렌더링하고 종료
      } catch {}
    }

    // 캐시가 없으면 스피너 표시 후 데이터 요청
    const spinner = document.createElement('div');
    spinner.className = 'grid-spinner';
    ul.parentNode.insertBefore(spinner, ul);
    try {
      const products = await fetchProducts(ul.dataset.directNos, ul.dataset.cate, ul.dataset.count);
      localStorage.setItem(storageKey, JSON.stringify(products));
      renderProducts(ul, products, cols);
    } catch (err) {
      const errDiv = document.createElement('div');
      errDiv.style.textAlign = 'center';
      errDiv.innerHTML = `<p style="color:#f00;">상품 로드에 실패했습니다.</p><button style="padding:6px 12px;cursor:pointer;">다시 시도</button>`;
      errDiv.querySelector('button').onclick = () => { errDiv.remove(); loadPanel(ul); };
      ul.parentNode.insertBefore(errDiv, ul);
    } finally {
      spinner.remove();
    }
  }
  
  // ✨✨✨ END: NEW/MODIFIED FUNCTIONS ✨✨✨

  // ────────────────────────────────────────────────────────────────
  // 5) 상품 렌더링
  // ────────────────────────────────────────────────────────────────
  function renderProducts(ul, products, cols) {
    ul.style.cssText = `display:grid; grid-template-columns:repeat(${cols},1fr); gap:10px; max-width:800px; margin:0 auto;`;
    const formatKRW = val => {
      if (typeof val === 'number') return `${val.toLocaleString('ko-KR')}원`;
      const num = parseFloat(String(val).replace(/[^\d.-]/g, '')) || 0;
      return `${num.toLocaleString('ko-KR')}원`;
    };
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
      const apiPercent = parseNumber(p.benefit_percentage);
      let displayPercent = null;
      if (apiPercent > 0) displayPercent = Math.round(apiPercent);
      else if (benefitPrice > 0 && origPrice > 0) displayPercent = Math.round((origPrice - benefitPrice) / origPrice * 100);
      else if (salePrice > 0 && origPrice > 0) displayPercent = Math.round((origPrice - salePrice) / origPrice * 100);

      const priceText = formatKRW(origPrice);
      const saleText = salePrice != null ? formatKRW(salePrice) : null;
      const couponText = benefitPrice != null ? formatKRW(benefitPrice) : null;
      const salePercent = (salePrice != null && origPrice > 0) ? Math.round((origPrice - salePrice) / origPrice * 100) : null;

      return `
        <li style="list-style:none;">
          <a href="/product/detail.html?product_no=${p.product_no}" class="prd_link" style="text-decoration:none;color:inherit;" data-track-click="product" data-product-no="${p.product_no}" target="_blank" rel="noopener noreferrer">
            <img src="${p.list_image}" alt="${escapeHtml(p.product_name||'')}" style="width:100%;display:block;" />
            <div class="prd_desc" style="font-size:14px;color:#666;padding:4px 0;">${p.summary_description || ''}</div>
            <div class="prd_name" style="font-weight:500;padding-bottom:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(p.product_name || '')}</div>
          </a>
          <div class="prd_price"${couponText ? ' style="display:none;"' : ''} style="font-size:16px;font-weight:500;">
            ${saleText ? `<span class="original_price" style="text-decoration: line-through; color: #999; margin-right: 6px;width:100%;display:block;font-size:12px;">${priceText}</span><span class="sale_price">${saleText}</span>` : `<span>${priceText}</span>`}
            ${(salePercent > 0) ? `<div class="sale_wrapper" style="display:inline-block;margin-right:4px;"><span class="sale_percent" style="color:#ff4d4f;">${salePercent}%</span></div>` : ''}
          </div>
          ${couponText ? `<div class="coupon_wrapper" style="margin-top:4px;display:flex;align-items:center;"><span class="original_price" style="text-decoration: line-through; color: #999; margin-right: 6px;display:block;font-size:12px;width:100%;">${priceText}</span>` + (displayPercent ? `<span class="prd_coupon_percent" style="color:#ff4d4f;font-weight:500;margin-right:4px;">${displayPercent}%</span>` : '') + `<span class="prd_coupon" style="font-weight:500;">${couponText}</span></div>` : ''}
        </li>`;
    }).join('');
  }

  // ────────────────────────────────────────────────────────────────
  // 6) CSS 주입
  // ────────────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.textContent = `
  .grid-spinner { width: 40px; height: 40px; border: 4px solid #f3f3f3; border-top: 4px solid ${activeColor}; border-radius: 50%; animation: spin_${pageId} 1s linear infinite; margin: 20px auto; }
  @keyframes spin_${pageId} { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg);} }
  .main_Grid_${pageId}{padding-top:10px;padding-bottom:30px}
  .main_Grid_${pageId} .prd_name{-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;}
  .product_list_widget{padding:20px 0;}
  .tabs_${pageId} { display: grid; gap: 8px; max-width: 800px; margin: 16px auto; grid-template-columns: repeat(${tabCount},1fr); }
  .tabs_${pageId} button { padding: 8px; font-size: 16px; border: none; background: #f5f5f5; color: #333; cursor: pointer; border-radius: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tabs_${pageId} button.active { background-color:${activeColor}; color:#fff; font-weight:600;}
  .main_Grid_${pageId} img { padding-bottom:10px; }
  .main_Grid_${pageId} { row-gap:50px!important; }
  .main_Grid_${pageId} li { color:#000; }
  .main_Grid_${pageId} .prd_desc { padding-bottom:3px; font-size:14px; color:#666; ;}
  .main_Grid_${pageId} .prd_price { font-size:16px; }
  .main_Grid_${pageId} .coupon_wrapper, .main_Grid_${pageId} .sale_wrapper { margin-top:4px; display:flex; align-items:center; }
  .main_Grid_${pageId} .prd_coupon_percent, .main_Grid_${pageId} .sale_percent { color:#ff4d4f; font-weight:500; margin-right:4px; }
  .main_Grid_${pageId} .sale_price, .main_Grid_${pageId} .prd_coupon { font-weight:500; }
  @media (max-width: 400px) {
    .tabs_${pageId}{ width:95%; margin:0 auto;margin-top:20px; font-weight:bold; }
    .tabs_${pageId} button{ font-size:14px; }
    .main_Grid_${pageId}{ width:95%; margin:0 auto; row-gap:30px!important; }
    .main_Grid_${pageId} .prd_desc{ font-size:12px; padding-bottom:5px; }
    .main_Grid_${pageId} .prd_price{ font-size:15px; }
    .main_Grid_${pageId} .sale_percent, .main_Grid_${pageId} .prd_coupon_percent{ font-size:15px; }
  }`;
  document.head.appendChild(style);

  // ────────────────────────────────────────────────────────────────
  // 7) 메인 데이터 처리 및 전역 함수
  // ────────────────────────────────────────────────────────────────
  async function initializePage() {
    try {
      const response = await fetch(`${API_BASE}/api/${mallId}/events/${pageId}`);
      if (!response.ok) throw new Error('Event data fetch failed');
      const ev = await response.json();
      
      const rawBlocks = Array.isArray(ev?.content?.blocks) && ev.content.blocks.length ? ev.content.blocks : (ev.images || []).map(img => ({ type: 'image', src: img.src, regions: img.regions || [] }));
      const blocks = rawBlocks.map(b => {
        const t = b.type || 'image';
        if (t === 'video') return { type: 'video', youtubeId: b.youtubeId || parseYouTubeId(b.src), ratio: (b.ratio && b.ratio.w && b.ratio.h) ? b.ratio : { w: 16, h: 9 }, autoplay: toBool(b.autoplay), loop: toBool(b.loop) };
        if (t === 'text') return { type: 'text', text: b.text || '', style: b.style || {} };
        return { type: 'image', src: b.src, regions: (b.regions || []).map(r => ({ xRatio: r.xRatio, yRatio: r.yRatio, wRatio: r.wRatio, hRatio: r.hRatio, href: r.href, coupon: r.coupon })) };
      });
      renderBlocks(blocks);
      document.querySelectorAll(`ul.main_Grid_${pageId}`).forEach(ul => loadPanel(ul));
    } catch (err) {
      console.error('EVENT LOAD ERROR', err);
    }
  }

  window.showTab = (id, btn) => {
    document.querySelectorAll(`.tab-content_${pageId}`).forEach(el => el.style.display = 'none');
    document.querySelectorAll(`.tabs_${pageId} button`).forEach(b => b.classList.remove('active'));
    const panel = document.getElementById(id);
    if (panel) panel.style.display = 'block';
    if (btn) btn.classList.add('active');
  };
  window.downloadCoupon = coupons => {
    const list = String(coupons || '').split(',').map(s => s.trim()).filter(Boolean);
    if (list.length === 0) return;
    const url = `/exec/front/newcoupon/IssueDownload?coupon_no=${encodeURIComponent(list.join(','))}`;
    window.open(url + `&opener_url=${encodeURIComponent(location.href)}`, '_blank');
    try {
      setTimeout(() => {
        document.querySelectorAll(`ul.main_Grid_${pageId}`).forEach(ul => {
          const baseCacheKey = ul.dataset.directNos ? `direct_${ul.dataset.directNos}` : (ul.dataset.cate ? `cat_${ul.dataset.cate}` : null);
          if(baseCacheKey) localStorage.removeItem(makeStorageKey(baseCacheKey));
          loadPanel(ul);
        });
      }, 600);
    } catch (e) {}
  };

  // ────────────────────────────────────────────────────────────────
  // 8) 탭-링크 핸들러
  // ────────────────────────────────────────────────────────────────
  (function attachTabHandler() {
    const SCROLL_OFFSET = 200;
    function scrollToElementOffset(el) {
      if (!el) return;
      const top = Math.max(0, el.getBoundingClientRect().top + window.scrollY - SCROLL_OFFSET);
      window.scrollTo({ top, behavior: 'smooth' });
    }
    function tryScrollPanel(tabId) {
      let attempts = 0;
      const timer = setInterval(() => {
        const panel = document.getElementById(tabId);
        if (panel || ++attempts >= 6) {
          clearInterval(timer);
          if (panel) scrollToElementOffset(panel);
        }
      }, 80);
    }
    function normalizeTabId(raw) {
      if (!raw) return null;
      raw = String(raw).trim().replace(/^#/, '');
      const m = raw.match(/^tab[:\s\-]?(\d+)$/i);
      return m ? 'tab-' + m[1] : (/^tab-\d+$/i.test(raw) ? raw : null);
    }
    document.addEventListener('click', function (ev) {
      const el = ev.target.closest('a, button, [data-href]');
      if (!el) return;
      const raw = el.getAttribute('data-href') || el.getAttribute('href');
      const tabId = normalizeTabId(raw);
      if (!tabId) return;
      ev.preventDefault();
      ev.stopPropagation();
      const btn = document.querySelector(`.tabs_${pageId} button[onclick*="'${tabId}'"]`);
      if (typeof window.showTab === 'function') {
        window.showTab(tabId, btn);
        tryScrollPanel(tabId);
      }
    }, { passive: false });
  })();

  // ────────────────────────────────────────────────────────────────
  // 9) 주기적 캐시 갱신 (Polling)
  // ────────────────────────────────────────────────────────────────
  (function initializeAndStartPolling() {
    // 1. 페이지 최초 진입 시, 데이터를 불러와 화면을 렌더링
    initializePage();

    // 2. 백그라운드에서 주기적으로 캐시를 갱신하는 함수
    async function updateCacheInBackground() {
      console.log('[widget.js] 백그라운드에서 업데이트를 확인합니다...');
      const productLists = Array.from(document.querySelectorAll(`ul.main_Grid_${pageId}`));

      for (const ul of productLists) {
        try {
          const baseCacheKey = ul.dataset.directNos ? `direct_${ul.dataset.directNos}` : (ul.dataset.cate ? `cat_${ul.dataset.cate}` : null);
          if (!baseCacheKey) continue;
          
          const storageKey = makeStorageKey(baseCacheKey);
          const oldDataString = localStorage.getItem(storageKey);
          
          // 최신 데이터를 서버에서 직접 가져옴
          const newData = await fetchProducts(ul.dataset.directNos, ul.dataset.cate, ul.dataset.count);
          const newDataString = JSON.stringify(newData);
          
          // 기존 캐시와 최신 데이터를 직접 비교
          if (oldDataString !== newDataString) {
            console.log(`[widget.js] ${baseCacheKey} 에서 변경사항을 발견하여 캐시를 업데이트합니다.`);
            localStorage.setItem(storageKey, newDataString);
          }
        } catch (err) {
          console.error(`[widget.js] 상품 목록 캐시를 업데이트하는 중 오류가 발생했습니다.`, err);
        }
      }
    }

    // 3. 캐시 갱신 Polling 시작
    // 💡 아래 시간(ms 단위)을 조절하여 캐시 확인 주기를 변경할 수 있습니다.
    const POLLING_INTERVAL_MS = 300000; // 현재 5분 (300,000ms)

    setInterval(updateCacheInBackground, POLLING_INTERVAL_MS);
    
    console.log(`[widget.js] 백그라운드 캐시 업데이트가 시작되었습니다. (${POLLING_INTERVAL_MS / 1000 / 60}분 간격)`);
  })();

})(); // end IIFE