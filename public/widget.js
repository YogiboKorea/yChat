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
  const storagePrefix = `widgetCache_${pageId}_`;
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
  function invalidateProductCache() {
    try {
      const keys = Object.keys(localStorage);
      for (const k of keys) {
        if (k.startsWith(storagePrefix)) {
          localStorage.removeItem(k);
        }
      }
      console.info('[widget.js] Product cache invalidated.');
    } catch (e) {
      console.warn('[widget.js] invalidateProductCache error', e);
    }
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
  // 2-1) 새로고침 시 캐시 자동 삭제
  // ────────────────────────────────────────────────────────────────
  (function clearCacheOnReload() {
    try {
      const navigationEntries = performance.getEntriesByType("navigation");
      if (navigationEntries.length > 0 && navigationEntries[0].type === 'reload') {
        console.log('[widget.js] 페이지 새로고침을 감지하여 캐시를 삭제합니다.');
        invalidateProductCache();
      }
    } catch (e) {
      console.warn('[widget.js] 새로고침 감지 중 오류:', e);
    }
  })();

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
  async function fetchProducts(directNosAttr, category, limit = 300) {
    const fetchOpts = { cache: 'no-store', headers: { 'Cache-Control': 'no-cache' } };
    const ulDirect = directNosAttr || directNos;

    // API에서 반환하는 상품 객체에 아이콘 관련 필드를 추가합니다.
    const mapProductData = p => ({
      product_no: p.product_no,
      product_name: p.product_name,
      summary_description: p.summary_description || '',
      price: p.price,
      list_image: p.list_image,
      sale_price: p.sale_price || null,
      benefit_price: p.benefit_price || null,
      benefit_percentage: p.benefit_percentage || null,
      icons: p.icons || null,
      additional_icons: p.additional_icons || [],
      product_tags: p.product_tags || ''
    });

    if (ulDirect) {
      const ids = ulDirect.split(',').map(s => s.trim()).filter(Boolean);
      const results = await Promise.all(ids.map(no =>
        fetchWithRetry(`${API_BASE}/api/${mallId}/products/${no}${couponQSStart}`, fetchOpts).then(r => r.json())
      ));
      return results.map(p => (p && p.product_no) ? p : {}).map(mapProductData);
    } else if (category) {
      const prodUrl = `${API_BASE}/api/${mallId}/categories/${category}/products?limit=${limit}${couponQSAppend}`;
      const [rawProducts] = await Promise.all([
        fetchWithRetry(prodUrl, fetchOpts).then(r => r.json()).then(json => Array.isArray(json) ? json : (json.products || [])),
      ]);
      return rawProducts.map(p => (typeof p === 'object' ? p : {})).map(mapProductData);
    }
    return [];
  }

  async function loadPanel(ul) {
    const cols = parseInt(ul.dataset.gridSize, 10) || 1;
    const baseCacheKey = ul.dataset.directNos ? `direct_${ul.dataset.directNos}` : (ul.dataset.cate ? `cat_${ul.dataset.cate}` : null);
    if (!baseCacheKey) return;
    const storageKey = storagePrefix + baseCacheKey;

    const stored = localStorage.getItem(storageKey);
    if (stored) {
      try {
        renderProducts(ul, JSON.parse(stored), cols);
        return;
      } catch {}
    }

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

    // 상품 태그와 아이콘 이미지 URL을 매핑하는 객체 (선택 사항)
    const TAG_ICON_MAP = {
      // "자체제작": "https://path/to/your/custom-icon-handmade.png",
    };

    ul.innerHTML = products.map(p => {
      const origPrice = parseNumber(p.price) || 0;
      const salePrice = parseNumber(p.sale_price);
      const benefitPrice = parseNumber(p.benefit_price);

      const isSale = salePrice != null && salePrice < origPrice;
      const isCoupon = benefitPrice != null && benefitPrice < origPrice;

      const apiPercent = parseNumber(p.benefit_percentage);
      let displayPercent = null;
      if (isCoupon) {
        if (apiPercent > 0) displayPercent = Math.round(apiPercent);
        else if (benefitPrice > 0 && origPrice > 0) displayPercent = Math.round((origPrice - benefitPrice) / origPrice * 100);
      } else if (isSale) {
        displayPercent = Math.round((origPrice - salePrice) / origPrice * 100);
      }

      const priceText = formatKRW(origPrice);
      const saleText = isSale ? formatKRW(salePrice) : null;
      const couponText = isCoupon ? formatKRW(benefitPrice) : null;
      const salePercent = isSale ? displayPercent : null;

      // 아이콘 HTML 생성 로직
      let iconHtml = '';
      const renderedUrls = new Set(); // 중복 아이콘 방지

      // 1. additional_icons ('아이콘 꾸미기' 아이콘)
      if (Array.isArray(p.additional_icons)) {
        p.additional_icons.forEach(icon => {
          if (icon.icon_url && !renderedUrls.has(icon.icon_url)) {
            iconHtml += `<img src="${icon.icon_url}" alt="${escapeHtml(icon.icon_alt || '상품 아이콘')}" class="prd_icon" />`;
            renderedUrls.add(icon.icon_url);
          }
        });
      }

      // 2. icons (시스템 기본 아이콘)
      if (p.icons) {
        ['icon_new', 'icon_recom', 'icon_best', 'icon_sale'].forEach(key => {
          const url = p.icons[key];
          if (url && !renderedUrls.has(url)) {
            const altText = key.replace('icon_', '') + ' 아이콘';
            iconHtml += `<img src="${url}" alt="${altText}" class="prd_icon" />`;
            renderedUrls.add(url);
          }
        });
      }

      // 3. product_tags (상품 태그 기반 아이콘 - 선택 사항)
      if (p.product_tags) {
        const tags = p.product_tags.split(',').map(t => t.trim());
        tags.forEach(tag => {
          const url = TAG_ICON_MAP[tag];
          if (url && !renderedUrls.has(url)) {
            iconHtml += `<img src="${url}" alt="${escapeHtml(tag)}" class="prd_icon" />`;
            renderedUrls.add(url);
          }
        });
      }

      return `
        <li style="list-style:none;">
          <a href="/product/detail.html?product_no=${p.product_no}" class="prd_link" style="position:relative; text-decoration:none; color:inherit; display:block;" data-track-click="product" data-product-no="${p.product_no}" target="_blank" rel="noopener noreferrer">
            <img src="${p.list_image}" alt="${escapeHtml(p.product_name||'')}" style="width:100%;display:block;" />
            ${iconHtml ? `<div class="prd_icons">${iconHtml}</div>` : ''}
            <div class="prd_desc" style="font-size:14px;color:#666;padding:4px 0;">${p.summary_description || ''}</div>
            <div class="prd_name" style="font-weight:500;padding-bottom:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(p.product_name || '')}</div>
          </a>
          <div class="prd_price_container">
            <div class="prd_price"${couponText ? ' style="display:none;"' : ''}>
              ${
                isSale
                  ? `<span class="original_price">${priceText}</span>
                     ${(salePercent > 0) ? `<span class="sale_percent">${salePercent}%</span>` : ''}
                     <span class="sale_price">${saleText}</span>`
                  : `<span>${priceText}</span>`
              }
            </div>
            ${couponText ? `<div class="coupon_wrapper">
                               <span class="original_price">${priceText}</span>
                               ${displayPercent ? `<span class="prd_coupon_percent">${displayPercent}%</span>` : ''}
                               <span class="prd_coupon">${couponText}</span>
                             </div>` : ''}
          </div>
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
  
  /* PRICE STYLES */
  .main_Grid_${pageId} .prd_price,
  .main_Grid_${pageId} .coupon_wrapper { font-size: 16px; font-weight: 500; }
  .main_Grid_${pageId} .original_price { text-decoration: line-through; color: #999; width:100%; display:block; font-size:13px; font-weight: 400; }
  .main_Grid_${pageId} .sale_percent,
  .main_Grid_${pageId} .prd_coupon_percent { color: #ff4d4f; font-weight: bold; margin-right: 4px; }
  .main_Grid_${pageId} .sale_price,
  .main_Grid_${pageId} .prd_coupon { font-weight: bold; }

  /* ICONS STYLE */
  .main_Grid_${pageId} .prd_icons {
    position: absolute;
    top: 8px;
    left: 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    pointer-events: none; /* 아이콘이 링크 클릭을 방해하지 않도록 */
  }
  .main_Grid_${pageId} .prd_icon {
    height: 24px; /* 아이콘 높이 통일 */
    width: auto;
    padding-bottom: 0; /* 이미지 기본 패딩 제거 */
  }

  @media (max-width: 400px) {
    .tabs_${pageId}{ width:95%; margin:0 auto;margin-top:20px; font-weight:bold; }
    .tabs_${pageId} button{ font-size:14px; }
    .main_Grid_${pageId}{ width:95%; margin:0 auto; row-gap:30px!important; }
    .main_Grid_${pageId} .prd_desc{ font-size:12px; padding-bottom:5px; }
    .main_Grid_${pageId} .prd_price,
    .main_Grid_${pageId} .coupon_wrapper {
        font-size: 15px;
    }
    .main_Grid_${pageId} .original_price {
        font-size: 12px;
    }
   .main_Grid_${pageId} .original_price {padding-bottom:10px; }       
  }`;
  document.head.appendChild(style);

  // ────────────────────────────────────────────────────────────────
  // 7) 메인 초기화 및 전역 함수
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
          if(baseCacheKey) localStorage.removeItem(storagePrefix + baseCacheKey);
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
  // 9) 페이지 초기화
  // ────────────────────────────────────────────────────────────────
  initializePage();

})(); // end IIFE