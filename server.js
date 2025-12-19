const express = require("express");
const multer = require('multer');
const ftp = require('basic-ftp');
const dayjs = require('dayjs');
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");
const fs = require("fs");
const axios = require("axios");

const router = express.Router();

// ========== [환경 설정 및 상수] ==========
const {
  MONGODB_URI,
  DB_NAME,
  CAFE24_MALLID,
  ACCESS_TOKEN,
  CAFE24_API_VERSION = "2024-06-01"
} = process.env;

const MALL_ID = 'yogibo';
const FTP_HOST = 'yogibo.ftp.cafe24.com';
const FTP_USER = 'yogibo';
const FTP_PASS = 'korea2025!!';
const FTP_PUBLIC_BASE = (process.env.FTP_PUBLIC_BASE || 'http://yogibo.openhost.cafe24.com/web/img/temple').replace(/\/+$/,'');
const EVENT_COLL = 'eventTemple';

// ========== [헬퍼 함수: DB 연결] ==========
const runDb = async (task) => {
  const client = new MongoClient(MONGODB_URI, { maxPoolSize: 8 });
  try {
    await client.connect();
    return await task(client.db(DB_NAME));
  } catch (err) {
    console.error('[DB Helper Error]', err);
    throw err;
  } finally {
    await client.close();
  }
};

// ========== [헬퍼 함수: Cafe24 API 요청] ==========
async function apiRequest(method, url, data = {}, params = {}) {
  try {
    const response = await axios({
      method,
      url,
      data,
      params,
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Cafe24-Api-Version': CAFE24_API_VERSION
      },
    });
    return response.data;
  } catch (error) {
    console.error(`[API Request Error] ${method} ${url}:`, error.message);
    throw error;
  }
}

// ========== [헬퍼 함수: 데이터 정규화] ==========
function normalizeBlocks(blocks = []) {
  if (!Array.isArray(blocks)) return [];
  return blocks.map(b => {
    const type = b?.type || 'image';
    if (type === 'video') {
      return {
        ...b,
        autoplay: b?.autoplay === true || b?.autoplay === 'true' || b?.autoplay === 1 || b?.autoplay === '1'
      };
    }
    return b;
  });
}

// ========== [🛠️ 핵심 헬퍼: pageId 검색 조건 생성] ==========
// pageId가 문자열("60d...")로 저장됐든 ObjectId로 저장됐든 모두 찾아내는 필터 생성
function createPageIdMatch(pageId) {
    const conditions = [{ pageId: pageId }]; // 문자열 일치 확인
    if (ObjectId.isValid(pageId)) {
        conditions.push({ pageId: new ObjectId(pageId) }); // ObjectId 일치 확인
    }
    return { $or: conditions };
}


// ==================================================================
// [1] 이미지 FTP 업로드
// ==================================================================
const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) { 
        const uploadPath = path.join(__dirname, '../uploads');
        if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });
        cb(null, uploadPath); 
    },
    filename(req, file, cb) { cb(null, `${Date.now()}_${file.originalname}`); },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.post('/api/:_any/uploads/image', upload.single('file'), async (req, res) => {
  const localPath = req.file?.path;
  const filename  = req.file?.filename;
  if (!localPath || !filename) return res.status(400).json({ error: '파일이 없습니다.' });

  const client = new ftp.Client(15000);
  client.ftp.verbose = false;

  try {
    await client.access({
      host: FTP_HOST, user: FTP_USER, password: FTP_PASS, secure: false,
    });

    const ymd = dayjs().format('YYYY/MM/DD');
    const relSuffix = `${MALL_ID}/${ymd}`;
    const baseCandidates = ['web/img/temple/uploads', 'img/temple/uploads', 'temple/uploads'];
    
    let uploaded = false;
    let finalPwd = null;
    let usedBase = null;

    for (const base of baseCandidates) {
      try {
        try { await client.cd('/'); } catch {}
        await client.cd(base);
        await client.ensureDir(relSuffix);
        finalPwd = await client.pwd();
        
        await client.uploadFrom(localPath, filename);
        uploaded = true;
        usedBase = base;
        break; 
      } catch (e) { continue; }
    }

    if (!uploaded) throw new Error('업로드 경로 진입 실패');
    
    let size = -1;
    try { size = await client.size(filename); } catch {}

    const url = `${FTP_PUBLIC_BASE}/uploads/${relSuffix}/${filename}`.replace(/([^:]\/)\/+/g, '$1');

    return res.json({ 
        url, 
        ftpBase: usedBase,
        ftpDir: finalPwd,
        ftpPath: `${finalPwd}/${filename}`,
        size
    });

  } catch (err) {
    console.error('[FTP UPLOAD ERROR]', err);
    return res.status(500).json({ error: '이미지 업로드 실패(FTP)', detail: err.message });
  } finally {
    try { client.close(); } catch {}
    fs.unlink(localPath, () => {});
  }
});


// ==================================================================
// [2] 템플릿(이벤트) CRUD
// ==================================================================

// 생성
router.post('/api/:_any/events', async (req, res) => {
  const payload = req.body;
  if (!payload.title || typeof payload.title !== 'string') return res.status(400).json({ error: '제목 필수' });
  
  try {
    const content = payload.content || {};
    if (Array.isArray(content.blocks)) content.blocks = normalizeBlocks(content.blocks);

    const doc = {
      mallId: MALL_ID,
      title: payload.title.trim(),
      content,
      images: payload.images || [],
      gridSize: payload.gridSize || null,
      layoutType: payload.layoutType || 'none',
      classification: payload.classification || {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await runDb(db => db.collection(EVENT_COLL).insertOne(doc));
    res.json({ _id: result.insertedId, ...doc });
  } catch (err) {
    console.error('[CREATE EVENT ERROR]', err);
    res.status(500).json({ error: '생성 실패' });
  }
});

// 목록
router.get('/api/:_any/events', async (req, res) => {
  try {
    const list = await runDb(db => 
      db.collection(EVENT_COLL).find({ mallId: MALL_ID }).sort({ createdAt: -1 }).toArray()
    );
    res.json(list);
  } catch (err) {
    console.error('[GET EVENTS ERROR]', err);
    res.status(500).json({ error: '목록 조회 실패' });
  }
});

// 상세
router.get('/api/:_any/events/:id', async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'ID 오류' });

  try {
    const ev = await runDb(db => db.collection(EVENT_COLL).findOne({ _id: new ObjectId(id), mallId: MALL_ID }));
    if (!ev) return res.status(404).json({ error: '이벤트 없음' });
    res.json(ev);
  } catch (err) {
    console.error('[GET EVENT ERROR]', err);
    res.status(500).json({ error: '상세 조회 실패' });
  }
});

// 수정
router.put('/api/:_any/events/:id', async (req, res) => {
  const { id } = req.params;
  const payload = req.body;
  if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'ID 오류' });

  const update = { updatedAt: new Date() };
  if (payload.title) update.title = payload.title.trim();
  if (payload.content) {
    const content = payload.content;
    if (Array.isArray(content.blocks)) content.blocks = normalizeBlocks(content.blocks);
    update.content = content;
  }
  if (Array.isArray(payload.images)) update.images = payload.images;
  if (payload.gridSize !== undefined) update.gridSize = payload.gridSize;
  if (payload.layoutType) update.layoutType = payload.layoutType;
  if (payload.classification) update.classification = payload.classification;

  try {
    const result = await runDb(db => 
      db.collection(EVENT_COLL).updateOne({ _id: new ObjectId(id), mallId: MALL_ID }, { $set: update })
    );
    if (result.matchedCount === 0) return res.status(404).json({ error: '이벤트 없음' });
    
    const updated = await runDb(db => db.collection(EVENT_COLL).findOne({ _id: new ObjectId(id) }));
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[UPDATE EVENT ERROR]', err);
    res.status(500).json({ error: '수정 실패' });
  }
});

// 삭제
router.delete('/api/:_any/events/:id', async (req, res) => {
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return res.status(400).json({ error: 'ID 오류' });
  
  try {
    const r = await runDb(db => db.collection(EVENT_COLL).deleteOne({ _id: new ObjectId(id), mallId: MALL_ID }));
    if (!r.deletedCount) return res.status(404).json({ error: '이벤트 없음' });

    // 연관 로그 삭제
    await runDb(async db => {
      await Promise.all([
        db.collection(`visits_${MALL_ID}`).deleteMany({ pageId: id }),
        db.collection(`clicks_${MALL_ID}`).deleteMany({ pageId: id }),
        db.collection(`prdClick_${MALL_ID}`).deleteMany({ pageId: id })
      ]);
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[DELETE EVENT ERROR]', err);
    res.status(500).json({ error: '삭제 실패' });
  }
});


// ==================================================================
// [3] 트래킹 (Tracking)
// ==================================================================
router.post('/api/:_any/track', async (req, res) => {
  const { pageId, pageUrl, visitorId, referrer, device, type, element, timestamp, productNo } = req.body;
  if (!pageId || !visitorId || !type || !timestamp) return res.status(400).json({ error: '필수 필드 누락' });
  
  try {
    // 🛠️ 트래킹 전 이벤트 존재 확인 (String/ObjectId 모두 체크)
    const existsMatch = createPageIdMatch(pageId);
    // $or 조건 중 하나라도 만족하는지 확인 (하나라도 ObjectId 형식이면 해당 필드로 쿼리)
    const exists = await runDb(db => db.collection(EVENT_COLL).findOne(existsMatch));
    
    // 이벤트가 없으면 트래킹 스킵 (단, 기존 데이터 정합성을 위해 ObjectId 변환 실패 등은 무시하고 진행할 수도 있음)
    // 여기서는 일단 존재 여부만 체크하고 진행
    
    const ts = new Date(timestamp);
    const kst = new Date(ts.getTime() + 9 * 60 * 60 * 1000);
    const dateKey = kst.toISOString().slice(0, 10);
    
    let pathOnly;
    try { pathOnly = new URL(pageUrl).pathname; } catch { pathOnly = pageUrl; }

    await runDb(async db => {
      // 1. 상품 클릭
      if (type === 'click' && element === 'product' && productNo) {
         let productName = null;
         try {
            const prodRes = await apiRequest('GET', `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products/${productNo}`, {}, { shop_no: 1 });
            productName = (prodRes.product || prodRes.products?.[0])?.product_name || null;
         } catch (e) {}

         await db.collection(`prdClick_${MALL_ID}`).updateOne(
           { pageId, productNo },
           { 
             $inc: { clickCount: 1 }, 
             $setOnInsert: { productName, firstClickAt: kst, pageUrl: pathOnly, referrer, device },
             $set: { lastClickAt: kst }
           },
           { upsert: true }
         );
      }
      // 2. 쿠폰/URL 클릭
      else if (type === 'click') {
        if (element === 'coupon') {
            const coupons = Array.isArray(productNo) ? productNo : [productNo];
            await Promise.all(coupons.map(cpn => 
                db.collection(`clicks_${MALL_ID}`).insertOne({
                    pageId, visitorId, dateKey, pageUrl: pathOnly, referrer, device,
                    type, element, timestamp: kst, couponNo: cpn
                })
            ));
        } else {
            await db.collection(`clicks_${MALL_ID}`).insertOne({
                pageId, visitorId, dateKey, pageUrl: pathOnly, referrer, device,
                type, element, timestamp: kst
            });
        }
      }
      // 3. 페이지 뷰/재방문
      else if (type === 'view' || type === 'revisit') {
        const update = {
          $set: { lastVisit: kst, pageUrl: pathOnly, referrer, device },
          $setOnInsert: { firstVisit: kst },
          $inc: {}
        };
        if (type === 'view') update.$inc.viewCount = 1;
        if (type === 'revisit') update.$inc.revisitCount = 1;

        await db.collection(`visits_${MALL_ID}`).updateOne({ pageId, visitorId, dateKey }, update, { upsert: true });
      }
    });
    return res.sendStatus(204);

  } catch (err) {
    console.error('[TRACK ERROR]', err);
    return res.status(500).json({ error: '트래킹 실패' });
  }
});


// ==================================================================
// [4] 통계 분석 (Analytics) - 🛠️ 모든 API에 createPageIdMatch 적용 완료
// ==================================================================

// 4-1. URL 목록 조회
router.get('/api/:_any/analytics/:pageId/urls', async (req, res) => {
  const { pageId } = req.params;
  try {
    const match = createPageIdMatch(pageId);
    const urls = await runDb(db => db.collection(`visits_${MALL_ID}`).distinct('pageUrl', match));
    res.json(urls.filter(u => u && u.trim() !== '').sort());
  } catch (err) { res.json([]); }
});

// 4-2. 쿠폰 목록 조회
router.get('/api/:_any/analytics/:pageId/coupons-distinct', async (req, res) => {
  const { pageId } = req.params;
  try {
    const match = createPageIdMatch(pageId);
    match.element = 'coupon'; // $or 조건과 함께 element 조건 추가 (MongoDB는 쿼리 객체 내 $or와 다른 필드 병행 가능)
    
    // 주의: distinct 쿼리에서 $or와 일반 필드를 섞을 때는 쿼리 객체를 잘 구성해야 함.
    // createPageIdMatch가 { $or: [...] }를 반환하므로, 여기에 element: 'coupon'을 추가하면 됨.
    const query = { ...match, element: 'coupon' };

    const couponNos = await runDb(db => db.collection(`clicks_${MALL_ID}`).distinct('couponNo', query));
    res.json(couponNos.filter(c => c).sort());
  } catch (err) { res.json([]); }
});

// 4-3. 날짜별 방문자 통계 (페이지뷰 통계)
router.get('/api/:_any/analytics/:pageId/visitors-by-date', async (req, res) => {
  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: '날짜 필수' });

  // 🛠️ pageId 매칭 로직 적용 ($or 조건 병합)
  const match = { 
      ...createPageIdMatch(pageId),
      dateKey: { $gte: start_date.slice(0, 10), $lte: end_date.slice(0, 10) } 
  };
  if (url) match.pageUrl = url;
  
  try {
    const stats = await runDb(db => db.collection(`visits_${MALL_ID}`).aggregate([
      { $match: match },
      { $group: { _id: { date: '$dateKey', visitorId: '$visitorId' }, viewCount: { $sum: { $ifNull: ['$viewCount', 0] } }, revisitCount: { $sum: { $ifNull: ['$revisitCount', 0] } } } },
      { $group: { 
          _id: '$_id.date', 
          totalVisitors: { $sum: 1 }, 
          newVisitors: { $sum: { $cond: [{ $gt: ['$viewCount', 0] }, 1, 0] } },
          returningVisitors: { $sum: { $cond: [{ $gt: ['$revisitCount', 0] }, 1, 0] } }
      }},
      { $project: { _id: 0, date: '$_id', totalVisitors: 1, newVisitors: 1, returningVisitors: 1,
          revisitRate: { $concat: [ { $toString: { $round: [ { $multiply: [ { $cond: [ { $gt: ['$totalVisitors', 0] }, { $divide: ['$returningVisitors', '$totalVisitors'] }, 0 ] }, 100 ] }, 0 ] } }, ' %' ] } } },
      { $sort: { date: 1 } }
    ]).toArray());
    res.json(stats);
  } catch (err) { 
      console.error('[VISITORS ERROR]', err);
      res.status(500).json({ error: '집계 오류' }); 
  }
});

// 4-4. 날짜별 클릭 통계
router.get('/api/:_any/analytics/:pageId/clicks-by-date', async (req, res) => {
  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  if (!start_date || !end_date) return res.status(400).json({ error: '날짜 필수' });

  const match = { 
      ...createPageIdMatch(pageId),
      dateKey: { $gte: start_date.slice(0,10), $lte: end_date.slice(0,10) } 
  };
  if (url) match.pageUrl = url;

  try {
    const data = await runDb(db => db.collection(`clicks_${MALL_ID}`).aggregate([
      { $match: match },
      { $group: { _id: { date: '$dateKey', element: '$element' }, count: { $sum: 1 } } },
      { $group: { _id: '$_id.date',
          url:     { $sum: { $cond: [ { $eq: ['$_id.element','url'] }, '$count', 0 ] } },
          product: { $sum: { $cond: [ { $eq: ['$_id.element','product'] }, '$count', 0 ] } },
          coupon:  { $sum: { $cond: [ { $eq: ['$_id.element','coupon'] }, '$count', 0 ] } } } },
      { $project: { _id: 0, date: '$_id', 'URL 클릭':'$url', 'URL 클릭(기존 product)':'$product', '쿠폰 클릭':'$coupon' } },
      { $sort: { date: 1 } }
    ]).toArray());
    res.json(data);
  } catch (err) { res.status(500).json({ error: '클릭 집계 실패' }); }
});

// 4-5. 디바이스 통계 (유입 환경)
router.get('/api/:_any/analytics/:pageId/devices', async (req, res) => {
  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  const match = { 
      ...createPageIdMatch(pageId),
      dateKey: { $gte: start_date.slice(0,10), $lte: end_date.slice(0,10) } 
  };
  if (url) match.pageUrl = url;

  try {
    const data = await runDb(db => db.collection(`visits_${MALL_ID}`).aggregate([
       { $match: match },
       { $group: { _id: '$device', count: { $sum: { $add: [ { $ifNull: ['$viewCount',0] }, { $ifNull: ['$revisitCount',0] } ] } } } },
       { $project: { _id:0, device_type:'$_id', count:1 } }
    ]).toArray());
    res.json(data);
  } catch (err) { res.status(500).json({ error: '디바이스 집계 실패' }); }
});

// 4-6. 디바이스 통계 (날짜별)
router.get('/api/:_any/analytics/:pageId/devices-by-date', async (req, res) => {
  const { pageId } = req.params;
  const { start_date, end_date, url } = req.query;
  const match = { 
      ...createPageIdMatch(pageId),
      dateKey: { $gte: start_date.slice(0,10), $lte: end_date.slice(0,10) } 
  };
  if (url) match.pageUrl = url;

  try {
    const data = await runDb(db => db.collection(`visits_${MALL_ID}`).aggregate([
       { $match: match },
       { $group: { _id: { date:'$dateKey', device:'$device', visitor:'$visitorId' } } },
       { $group: { _id: { date:'$_id.date', device:'$_id.device' }, count: { $sum:1 } } },
       { $project: { _id:0, date:'$_id.date', device:'$_id.device', count:1 } },
       { $sort: { date:1, device:1 } }
    ]).toArray());
    res.json(data);
  } catch (err) { res.status(500).json({ error: '디바이스(일별) 집계 실패' }); }
});

// 4-7. 상품 퍼포먼스 (상품 클릭 데이터)
router.get('/api/:_any/analytics/:pageId/product-performance', async (req, res) => {
  const { pageId } = req.params;
  try {
    const match = createPageIdMatch(pageId); // 🛠️ 여기도 적용
    
    const clicks = await runDb(db => db.collection(`prdClick_${MALL_ID}`).aggregate([
      { $match: match },
      { $group: { _id: '$productNo', clicks: { $sum: '$clickCount' } } }
    ]).toArray());
    
    if (!clicks.length) return res.json([]);

    const productNos = clicks.map(c => c._id);
    const prodRes = await apiRequest('GET', `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products`, {}, {
      shop_no: 1, product_no: productNos.join(','), limit: productNos.length, fields: 'product_no,product_name'
    });
    const detailMap = (prodRes.products || []).reduce((m,p) => { m[p.product_no]=p.product_name; return m; }, {});

    const performance = clicks.map(c => ({ productNo: c._id, productName: detailMap[c._id] || '이름없음', clicks: c.clicks })).sort((a,b)=>b.clicks-a.clicks);
    res.json(performance);
  } catch (err) { res.status(500).json({ error: '상품 분석 실패' }); }
});

// 4-8. 상품 클릭 (단순 리스트)
router.get('/api/:_any/analytics/:pageId/product-clicks', async (req, res) => {
  const { pageId } = req.params;
  const { start_date, end_date } = req.query;

  // find 쿼리 구성
  const query = createPageIdMatch(pageId); // 🛠️ 적용 ({ $or: [...] })
  
  if (start_date && end_date) {
      query.lastClickAt = { $gte: new Date(start_date), $lte: new Date(end_date) };
  }

  try {
    const docs = await runDb(db => 
      db.collection(`prdClick_${MALL_ID}`).find(query).sort({ clickCount: -1 }).toArray()
    );
    res.json(docs.map(d => ({ productNo: d.productNo, clicks: d.clickCount })));
  } catch (err) { res.status(500).json({ error: '상품 클릭 조회 실패' }); }
});


// ==================================================================
// [5] Cafe24 연동
// ==================================================================

// 카테고리
router.get('/api/:_any/categories/all', async (req, res) => {
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const { categories = [] } = await apiRequest('GET', `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/categories`, {}, { limit, offset });
      if (!categories.length) break;
      all.push(...categories);
      offset += categories.length;
    }
    res.json(all);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 쿠폰
router.get('/api/:_any/coupons', async (req, res) => {
  try {
    const all = [];
    let offset = 0, limit = 100;
    while (true) {
      const { coupons = [] } = await apiRequest('GET', `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/coupons`, {}, { shop_no: 1, limit, offset });
      if (!coupons.length) break;
      all.push(...coupons);
      offset += coupons.length;
    }
    res.json(all);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 쿠폰 통계
router.get('/api/:_any/analytics/:pageId/coupon-stats', async (req, res) => {
  const { coupon_no, start_date, end_date } = req.query;
  if (!coupon_no) return res.status(400).json({ error: '필수값 누락' });
  const couponNos = coupon_no.split(',');
  const results = [];
  const now = new Date();

  try {
    for (const no of couponNos) {
      let couponName = '(이름없음)';
      try {
        const r = await apiRequest('GET', `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/coupons`, {}, { shop_no: 1, coupon_no: no, limit:1 });
        couponName = r.coupons?.[0]?.coupon_name || couponName;
      } catch {}

      let issued=0, used=0, unused=0, autoDel=0;
      let offset = 0;
      while(true) {
        const ir = await apiRequest('GET', `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/coupons/${no}/issues`, {}, { shop_no: 1, limit: 500, offset, issued_start_date: start_date, issued_end_date: end_date });
        const issues = ir.issues || [];
        if (!issues.length) break;
        for (const item of issues) {
          issued++;
          if (item.used_coupon === 'T') used++;
          else {
             const exp = item.expiration_date ? new Date(item.expiration_date) : null;
             if (exp && exp < now) autoDel++; else unused++;
          }
        }
        offset += 500;
      }
      results.push({ couponNo: no, couponName, issuedCount: issued, usedCount: used, unusedCount: unused, autoDeletedCount: autoDel });
    }
    res.json(results);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 카테고리 상품
router.get('/api/:_any/categories/:category_no/products', async (req, res) => {
  const { category_no } = req.params;
  try {
    const coupon_nos = (req.query.coupon_no || '').split(',').filter(Boolean);
    const limit = parseInt(req.query.limit, 10) || 100;
    const offset = parseInt(req.query.offset, 10) || 0;
    const shop_no = 1;

    // 1. 쿠폰
    const coupons = await Promise.all(coupon_nos.map(async no => {
      const { coupons: arr } = await apiRequest('GET', `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/coupons`, {}, { shop_no, coupon_no: no, fields: 'coupon_no,available_product,available_product_list,available_category,available_category_list,benefit_amount,benefit_percentage' });
      return arr?.[0] || null;
    }));
    const validCoupons = coupons.filter(Boolean);

    // 2. 카테고리 상품
    const catRes = await apiRequest('GET', `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/categories/${category_no}/products`, {}, { shop_no, display_group: 1, limit, offset });
    const sorted = (catRes.products || []).slice().sort((a,b)=>a.sequence_no-b.sequence_no);
    const productNos = sorted.map(p=>p.product_no);
    if (!productNos.length) return res.json([]);

    // 3. 상품 상세
    const detailRes = await apiRequest('GET', `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products`, {}, { shop_no, product_no: productNos.join(','), limit: productNos.length, fields: 'product_no,product_name,price,summary_description,list_image,icons,product_tags' });
    const detailMap = (detailRes.products || []).reduce((m,p)=>{ m[p.product_no]=p; return m; },{});

    // 4. 아이콘
    const iconPromises = productNos.map(async (no) => {
       try {
         const ir = await apiRequest('GET', `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products/${no}/icons`, {}, { shop_no });
         const d = ir?.icons;
         let lst = [];
         if(d) {
            if(d.use_show_date !== 'T') lst = d.image_list||[];
            else { const now = new Date(); if(now >= new Date(d.show_start_date) && now < new Date(d.show_end_date)) lst = d.image_list||[]; }
         }
         return { product_no: no, customIcons: lst.map(i => ({ icon_url: i.path, icon_alt: i.code })) };
       } catch { return { product_no: no, customIcons: [] }; }
    });
    const iconsMap = (await Promise.all(iconPromises)).reduce((m, item) => { m[item.product_no] = item.customIcons; return m; }, {});

    // 5. 할인가
    const discountMap = {};
    await Promise.all(productNos.map(async no => {
        const { discountprice } = await apiRequest('GET', `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products/${no}/discountprice`, {}, { shop_no });
        discountMap[no] = discountprice?.pc_discount_price != null ? parseFloat(discountprice.pc_discount_price) : null;
    }));

    // 6. 계산
    const formatKRW = num => num!=null ? Number(num).toLocaleString('ko-KR') + '원' : null;
    const result = productNos.map(no => {
       const p = detailMap[no];
       if (!p) return null;
       const couponInfos = validCoupons.map(coupon => {
          const pList = coupon.available_product_list || [];
          const cList = coupon.available_category_list || [];
          if (!((coupon.available_product==='U' || (coupon.available_product==='I' && pList.includes(no)) || (coupon.available_product==='E' && !pList.includes(no))) &&
                (coupon.available_category==='U' || (coupon.available_category==='I' && cList.includes(parseInt(category_no,10))) || (coupon.available_category==='E' && !cList.includes(parseInt(category_no,10)))))) return null;
          
          const orig = parseFloat(p.price || 0);
          const pct = parseFloat(coupon.benefit_percentage || 0);
          const amt = parseFloat(coupon.benefit_amount || 0);
          let val = null;
          if (pct>0) val = +(orig*(100-pct)/100).toFixed(2);
          else if (amt>0) val = +(orig-amt).toFixed(2);
          return val!=null ? { coupon_no: coupon.coupon_no, benefit_percentage: pct, benefit_price: val } : null;
       }).filter(Boolean).sort((a,b)=>b.benefit_percentage-a.benefit_percentage);
       
       const firstCpn = couponInfos[0];
       return {
         product_no: p.product_no,
         product_name: p.product_name,
         price: formatKRW(parseFloat(p.price)),
         summary_description: p.summary_description,
         list_image: p.list_image,
         sale_price: (discountMap[no]!=null && +discountMap[no]!==+p.price) ? formatKRW(discountMap[no]) : null,
         benefit_price: firstCpn ? formatKRW(firstCpn.benefit_price) : null,
         benefit_percentage: firstCpn ? firstCpn.benefit_percentage : null,
         couponInfos: couponInfos.length ? couponInfos : null,
         icons: p.icons,
         additional_icons: iconsMap[no] || [],
         product_tags: p.product_tags
       };
    }).filter(Boolean);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// 전체 상품
router.get('/api/:_any/products', async (req, res) => {
    try {
        const q = (req.query.q || '').trim();
        const limit = parseInt(req.query.limit,10)||1000;
        const offset = parseInt(req.query.offset,10)||0;
        const params = { shop_no: 1, limit, offset };
        if(q) params['search[product_name]'] = q;

        const data = await apiRequest('GET', `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products`, {}, params);
        const slim = (data.products||[]).map(p=>({ product_no: p.product_no, product_code: p.product_code, product_name: p.product_name, price: p.price, list_image: p.list_image }));
        res.json({ products: slim, total: data.total_count });
    } catch(err) { res.status(500).json({ error: '상품 조회 실패' }); }
});

// 단일 상품
router.get('/api/:_any/products/:product_no', async (req, res) => {
    const { product_no } = req.params;
    try {
        const shop_no = 1;
        const pd = await apiRequest('GET', `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products/${product_no}`, {}, { shop_no, fields: 'product_no,product_code,product_name,price,summary_description,list_image,icons,product_tags' });
        const p = pd.product || pd.products?.[0];
        if (!p) return res.status(404).json({ error: '상품 없음' });

        let customIcons = [];
        try {
            const ir = await apiRequest('GET', `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products/${product_no}/icons`, {}, { shop_no });
            const d = ir?.icons;
            if(d) {
               if(d.use_show_date !== 'T') customIcons = (d.image_list||[]).map(i=>({icon_url:i.path,icon_alt:i.code}));
               else { const now = new Date(); if(now >= new Date(d.show_start_date) && now < new Date(d.show_end_date)) customIcons = (d.image_list||[]).map(i=>({icon_url:i.path,icon_alt:i.code})); }
            }
        } catch {}

        const dr = await apiRequest('GET', `https://${CAFE24_MALLID}.cafe24api.com/api/v2/admin/products/${product_no}/discountprice`, {}, { shop_no });
        const sale_price = dr.discountprice?.pc_discount_price ? parseFloat(dr.discountprice.pc_discount_price) : null;

        res.json({
            product_no, product_code: p.product_code, product_name: p.product_name, price: p.price, summary_description: p.summary_description,
            sale_price, benefit_price: null, benefit_percentage: null, list_image: p.list_image, icons: p.icons, additional_icons: customIcons, product_tags: p.product_tags
        });
    } catch(err) { res.status(500).json({ error: '상세 조회 실패' }); }
});
//
module.exports = router;