const express = require('express');
const router = express.Router();
const { getDB } = require('../config/db');

// GET /api/game/detox/config - 성공 범위를 DB에서 가져오게 추가
router.get('/detox/config', async (req, res) => {
    try {
        const db = getDB();
        const config = await db.collection('game_detox_config').findOne({ type: 'success_criteria' });
        if (config) {
            res.json({ success: true, minTime: config.minTime, maxTime: config.maxTime });
        } else {
            // 기본값
            res.json({ success: true, minTime: 10000, maxTime: 11000 });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// POST /api/game/detox/config - 관리자가 성공 범위를 수정
router.post('/detox/config', async (req, res) => {
    try {
        const { minTime, maxTime } = req.body;
        const db = getDB();
        
        await db.collection('game_detox_config').updateOne(
            { type: 'success_criteria' },
            { $set: { minTime: parseInt(minTime), maxTime: parseInt(maxTime), updatedAt: new Date() } },
            { upsert: true }
        );
        res.json({ success: true, minTime, maxTime });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// GET /api/game/detox/status
router.get('/detox/status', async (req, res) => {
    try {
        const { memberId, guestId } = req.query;
        const db = getDB();
        const userId = memberId || guestId;

        if (!userId) {
            return res.status(400).json({ success: false, error: 'userId is required' });
        }

        const user = await db.collection('game_detox_users').findOne({ userId });

        let hearts = 0;
        let hasReceivedCoupon = false;
        let hasReceivedOnlineCoupon = false;
        let completedMissions = [];
        let downloadedCoupons = [];

        if (user) {
            hearts = user.hearts;
            hasReceivedCoupon = user.hasReceivedCoupon || false;
            hasReceivedOnlineCoupon = user.hasReceivedOnlineCoupon || false;
            completedMissions = user.completedMissions || [];
            downloadedCoupons = user.downloadedCoupons || [];

            // ✅ 회원인데 미션 없이 hearts > 2인 경우 (과거 잘못 초기화된 데이터 보정)
            // 미션으로 하트를 추가한 적 없는(completedMissions가 비어있는) 회원이
            // 2개를 초과하는 hearts를 가진 경우 2개로 재조정
            if (memberId && completedMissions.length === 0 && hearts > 2) {
                hearts = 2;
                await db.collection('game_detox_users').updateOne(
                    { userId },
                    { $set: { hearts: 2, isMember: true, updatedAt: new Date() } }
                );
            } else if (memberId && !user.isMember) {
                // 비회원 → 회원 전환 감지: isMember 플래그 업데이트
                await db.collection('game_detox_users').updateOne(
                    { userId },
                    { $set: { isMember: true, updatedAt: new Date() } }
                );
            }
        } else {
            // ✅ 초기 수치 설정: 회원 2개, 비회원 1개
            hearts = memberId ? 2 : 1;
            await db.collection('game_detox_users').insertOne({
                userId,
                isMember: !!memberId,
                hearts,
                hasReceivedCoupon: false,
                hasReceivedOnlineCoupon: false,
                completedMissions: [],
                downloadedCoupons: [],
                createdAt: new Date(),
                updatedAt: new Date()
            });
        }

        res.json({ success: true, hearts, hasReceivedCoupon, hasReceivedOnlineCoupon, completedMissions, downloadedCoupons });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// POST /api/game/detox/coupon - 쿠폰 수령 기록
router.post('/detox/coupon', async (req, res) => {
    try {
        const { memberId, couponIdx } = req.body;
        const db = getDB();

        if (!memberId) {
            return res.status(400).json({ success: false, error: '회원만 쿠폰을 수령할 수 있습니다.' });
        }

        const user = await db.collection('game_detox_users').findOne({ userId: memberId });
        if (user && user.downloadedCoupons && user.downloadedCoupons.includes(couponIdx)) {
            return res.json({ success: false, error: 'already_downloaded', downloadedCoupons: user.downloadedCoupons });
        }

        const updated = await db.collection('game_detox_users').findOneAndUpdate(
            { userId: memberId },
            {
                $addToSet: { downloadedCoupons: couponIdx },
                $set: { updatedAt: new Date() }
            },
            { returnDocument: 'after', upsert: true }
        );

        res.json({ success: true, downloadedCoupons: updated ? updated.downloadedCoupons : [couponIdx] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// POST /api/game/detox/mission - 미션 완료 기록
router.post('/detox/mission', async (req, res) => {
    try {
        const { memberId, missionIdx, reward } = req.body;
        const db = getDB();

        if (!memberId) {
            return res.status(400).json({ success: false, error: '회원만 미션을 이용할 수 있습니다.' });
        }

        const userId = memberId;

        // 이미 완료한 미션인지 확인
        const user = await db.collection('game_detox_users').findOne({ userId });
        if (user && user.completedMissions && user.completedMissions.includes(missionIdx)) {
            return res.json({ success: false, error: '이미 완료한 미션입니다.', alreadyDone: true, hearts: user.hearts });
        }

        // 미션 완료 기록 및 하트 증가
        const updated = await db.collection('game_detox_users').findOneAndUpdate(
            { userId },
            {
                $addToSet: { completedMissions: missionIdx },
                $inc: { hearts: reward },
                $set: { updatedAt: new Date() }
            },
            { returnDocument: 'after', upsert: true }
        );

        // ✅ 최대 하트 수는 5개로 유지하되, 예외 발생 시 기본값을 5에서 2로 변경
        const newHearts = updated ? Math.min(updated.hearts, 5) : 2;

        res.json({ success: true, hearts: newHearts, completedMissions: updated ? updated.completedMissions : [missionIdx] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// POST /api/game/detox/success
router.post('/detox/success', async (req, res) => {
    try {
        const { memberId, guestId, recordTime } = req.body;
        const db = getDB();
        const userId = memberId || guestId;

        if (!userId) {
            return res.status(400).json({ success: false, error: 'userId is required' });
        }

        await db.collection('game_detox_logs').insertOne({
            userId,
            isMember: !!memberId,
            result: 'success',
            recordTime: recordTime || null,
            createdAt: new Date()
        });

        let hearts = 0;
        let hasReceivedCoupon = false;
        let hasReceivedOnlineCoupon = false;

        const user = await db.collection('game_detox_users').findOne({ userId });
        if (user) {
            hearts = user.hearts;
            hasReceivedCoupon = user.hasReceivedCoupon || false;
            hasReceivedOnlineCoupon = user.hasReceivedOnlineCoupon || false;
        }

        res.json({ success: true, hearts, hasReceivedCoupon, hasReceivedOnlineCoupon });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// POST /api/game/detox/play - 게임 시작 (목숨 1 차감)
router.post('/detox/play', async (req, res) => {
    try {
        const { memberId, guestId } = req.body;
        const db = getDB();
        const userId = memberId || guestId;

        if (!userId) {
            return res.status(400).json({ success: false, error: 'userId is required' });
        }

        const user = await db.collection('game_detox_users').findOne({ userId });
        if (!user || user.hearts <= 0) {
            return res.json({ success: false, error: 'lack_of_hearts', hearts: 0 });
        }

        const updated = await db.collection('game_detox_users').findOneAndUpdate(
            { userId },
            {
                $inc: { hearts: -1 },
                $set: { updatedAt: new Date() }
            },
            { returnDocument: 'after' }
        );

        res.json({ success: true, hearts: updated ? Math.max(updated.hearts, 0) : 0 });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// POST /api/game/detox/claim - 상품 수령 처리 (type: 'offline' | 'online')
router.post('/detox/claim', async (req, res) => {
    try {
        const { memberId, guestId, type } = req.body;
        const db = getDB();
        const userId = memberId || guestId;

        if (!userId) {
            return res.status(400).json({ success: false, error: 'userId is required' });
        }

        // 중복 수령 체크
        const user = await db.collection('game_detox_users').findOne({ userId });
        if (type === 'offline' && user && user.hasReceivedCoupon) {
            return res.json({ success: false, error: 'already_claimed', type: 'offline' });
        }
        if (type === 'online' && user && user.hasReceivedOnlineCoupon) {
            return res.json({ success: false, error: 'already_claimed', type: 'online' });
        }

        const setFields = { updatedAt: new Date() };
        if (type === 'online') {
            setFields.hasReceivedOnlineCoupon = true;
        } else {
            // offline (기본값) - 하트 소진
            setFields.hasReceivedCoupon = true;
            setFields.hearts = 0;
        }

        await db.collection('game_detox_users').findOneAndUpdate(
            { userId },
            { $set: setFields },
            { returnDocument: 'after' }
        );

        const hearts = type === 'online' ? (user ? user.hearts : 0) : 0;
        res.json({
            success: true,
            hearts,
            hasReceivedCoupon: type !== 'online' ? true : (user ? user.hasReceivedCoupon || false : false),
            hasReceivedOnlineCoupon: type === 'online' ? true : (user ? user.hasReceivedOnlineCoupon || false : false)
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// POST /api/game/detox/fail
router.post('/detox/fail', async (req, res) => {
    try {
        const { memberId, guestId, recordTime } = req.body;
        const db = getDB();
        const userId = memberId || guestId;

        if (!userId) {
            return res.status(400).json({ success: false, error: 'userId is required' });
        }

        await db.collection('game_detox_logs').insertOne({
            userId,
            isMember: !!memberId,
            result: 'fail',
            recordTime: recordTime || null,
            createdAt: new Date()
        });

        const updated = await db.collection('game_detox_users').findOneAndUpdate(
            { userId },
            {
                $set: { updatedAt: new Date() }
            },
            { returnDocument: 'after' }
        );

        res.json({ success: true, hearts: updated ? Math.max(updated.hearts, 0) : 0 });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// GET /api/game/detox/successList - 성공자 목록 (명전)
router.get('/detox/successList', async (req, res) => {
    try {
        const db = getDB();
        // 회원 성공자만 조회 (isMember: true, result: 'success'), 최신순 최대 100건
        const logs = await db.collection('game_detox_logs')
            .find({ isMember: true, result: 'success' })
            .sort({ createdAt: -1 })
            .limit(100)
            .toArray();

        // 중복 제거 (한 사람이 여러 번 성공해도 1회만)
        const seen = new Set();
        const uniqueList = [];
        for (const log of logs) {
            if (!seen.has(log.userId)) {
                seen.add(log.userId);
                // 아이디 마스킹: 앞 3자리 + *** 처리
                const id = log.userId;
                const masked = id.length > 3 ? id.slice(0, 3) + '***' : id + '***';
                uniqueList.push(masked);
            }
            if (uniqueList.length >= 50) break;
        }

        res.json({ success: true, list: uniqueList });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, list: [] });
    }
});

// GET /api/game/detox/admin/logs - 관리자 대시보드에서 볼 모든 로그
router.get('/detox/admin/logs', async (req, res) => {
    try {
        const { date } = req.query;
        const db = getDB();
        
        // 1. 비회원 제외 (회원만)
        const query = { isMember: true };
        
        // 2. 날짜별 필터 추가 (파라미터가 있을 경우)
        if (date) {
            // 한국 시간(KST) 기준으로 하루의 시작과 끝 설정
            const startOfDay = new Date(`${date}T00:00:00+09:00`);
            const endOfDay = new Date(`${date}T23:59:59.999+09:00`);
            query.createdAt = { $gte: startOfDay, $lte: endOfDay };
        }

        const logs = await db.collection('game_detox_logs')
            .find(query)
            .sort({ createdAt: -1 })
            // 날짜별 조회일 경우 300건 한정을 제외하고 전체 출력 제한 없음
            .toArray();

        res.json({ success: true, logs });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// ============================================================
// 김포 매장 전용 라우트 (별도 DB 컬렉션: game_gimpo_users, game_gimpo_logs)
// ============================================================

// GET /api/game/gimpo/config
router.get('/gimpo/config', async (req, res) => {
    try {
        const db = getDB();
        const config = await db.collection('game_gimpo_config').findOne({ type: 'success_criteria' });
        if (config) {
            res.json({ success: true, minTime: config.minTime, maxTime: config.maxTime });
        } else {
            res.json({ success: true, minTime: 10000, maxTime: 11000 });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// POST /api/game/gimpo/config
router.post('/gimpo/config', async (req, res) => {
    try {
        const { minTime, maxTime } = req.body;
        const db = getDB();
        await db.collection('game_gimpo_config').updateOne(
            { type: 'success_criteria' },
            { $set: { minTime: parseInt(minTime), maxTime: parseInt(maxTime), updatedAt: new Date() } },
            { upsert: true }
        );
        res.json({ success: true, minTime, maxTime });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// GET /api/game/gimpo/status
router.get('/gimpo/status', async (req, res) => {
    try {
        const { memberId, guestId } = req.query;
        const db = getDB();
        const userId = memberId || guestId;
        if (!userId) return res.status(400).json({ success: false, error: 'userId is required' });

        const user = await db.collection('game_gimpo_users').findOne({ userId });
        let hearts = 0, hasReceivedCoupon = false, hasReceivedOnlineCoupon = false;
        let completedMissions = [], downloadedCoupons = [];

        if (user) {
            hearts = user.hearts;
            hasReceivedCoupon = user.hasReceivedCoupon || false;
            hasReceivedOnlineCoupon = user.hasReceivedOnlineCoupon || false;
            completedMissions = user.completedMissions || [];
            downloadedCoupons = user.downloadedCoupons || [];

            if (memberId && completedMissions.length === 0 && hearts > 2) {
                hearts = 2;
                await db.collection('game_gimpo_users').updateOne({ userId }, { $set: { hearts: 2, isMember: true, updatedAt: new Date() } });
            } else if (memberId && !user.isMember) {
                await db.collection('game_gimpo_users').updateOne({ userId }, { $set: { isMember: true, updatedAt: new Date() } });
            }
        } else {
            hearts = memberId ? 2 : 1;
            await db.collection('game_gimpo_users').insertOne({
                userId, isMember: !!memberId, hearts,
                hasReceivedCoupon: false, hasReceivedOnlineCoupon: false,
                completedMissions: [], downloadedCoupons: [],
                createdAt: new Date(), updatedAt: new Date()
            });
        }
        res.json({ success: true, hearts, hasReceivedCoupon, hasReceivedOnlineCoupon, completedMissions, downloadedCoupons });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// POST /api/game/gimpo/mission
router.post('/gimpo/mission', async (req, res) => {
    try {
        const { memberId, missionIdx, reward } = req.body;
        const db = getDB();
        if (!memberId) return res.status(400).json({ success: false, error: '회원만 미션을 이용할 수 있습니다.' });

        const user = await db.collection('game_gimpo_users').findOne({ userId: memberId });
        if (user && user.completedMissions && user.completedMissions.includes(missionIdx)) {
            return res.json({ success: false, error: '이미 완료한 미션입니다.', alreadyDone: true, hearts: user.hearts });
        }

        const updated = await db.collection('game_gimpo_users').findOneAndUpdate(
            { userId: memberId },
            { $addToSet: { completedMissions: missionIdx }, $inc: { hearts: reward }, $set: { updatedAt: new Date() } },
            { returnDocument: 'after', upsert: true }
        );
        const newHearts = updated ? Math.min(updated.hearts, 5) : 2;
        res.json({ success: true, hearts: newHearts, completedMissions: updated ? updated.completedMissions : [missionIdx] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// POST /api/game/gimpo/play
router.post('/gimpo/play', async (req, res) => {
    try {
        const { memberId, guestId } = req.body;
        const db = getDB();
        const userId = memberId || guestId;
        if (!userId) return res.status(400).json({ success: false, error: 'userId is required' });

        const user = await db.collection('game_gimpo_users').findOne({ userId });
        if (!user || user.hearts <= 0) return res.json({ success: false, error: 'lack_of_hearts', hearts: 0 });

        const updated = await db.collection('game_gimpo_users').findOneAndUpdate(
            { userId }, { $inc: { hearts: -1 }, $set: { updatedAt: new Date() } }, { returnDocument: 'after' }
        );
        res.json({ success: true, hearts: updated ? Math.max(updated.hearts, 0) : 0 });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// POST /api/game/gimpo/success
router.post('/gimpo/success', async (req, res) => {
    try {
        const { memberId, guestId, recordTime } = req.body;
        const db = getDB();
        const userId = memberId || guestId;
        if (!userId) return res.status(400).json({ success: false, error: 'userId is required' });

        await db.collection('game_gimpo_logs').insertOne({
            userId, isMember: !!memberId, result: 'success', recordTime: recordTime || null, createdAt: new Date()
        });

        const user = await db.collection('game_gimpo_users').findOne({ userId });
        let hearts = 0, hasReceivedCoupon = false, hasReceivedOnlineCoupon = false;
        if (user) {
            hearts = user.hearts;
            hasReceivedCoupon = user.hasReceivedCoupon || false;
            hasReceivedOnlineCoupon = user.hasReceivedOnlineCoupon || false;
        }
        res.json({ success: true, hearts, hasReceivedCoupon, hasReceivedOnlineCoupon });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// POST /api/game/gimpo/fail
router.post('/gimpo/fail', async (req, res) => {
    try {
        const { memberId, guestId, recordTime } = req.body;
        const db = getDB();
        const userId = memberId || guestId;
        if (!userId) return res.status(400).json({ success: false, error: 'userId is required' });

        await db.collection('game_gimpo_logs').insertOne({
            userId, isMember: !!memberId, result: 'fail', recordTime: recordTime || null, createdAt: new Date()
        });

        const updated = await db.collection('game_gimpo_users').findOneAndUpdate(
            { userId }, { $set: { updatedAt: new Date() } }, { returnDocument: 'after' }
        );
        res.json({ success: true, hearts: updated ? Math.max(updated.hearts, 0) : 0 });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// POST /api/game/gimpo/claim - 김포 매장 직원 확인 (type: 'offline' | 'snack')
router.post('/gimpo/claim', async (req, res) => {
    try {
        const { memberId, guestId, type } = req.body;
        const db = getDB();
        const userId = memberId || guestId;
        if (!userId) return res.status(400).json({ success: false, error: 'userId is required' });

        const user = await db.collection('game_gimpo_users').findOne({ userId });
        if (user && user.hasReceivedCoupon) {
            return res.json({ success: false, error: 'already_claimed', type });
        }

        // hearts 초기화 제거. 게임 더하기만 될 수 있게 유지
        await db.collection('game_gimpo_users').findOneAndUpdate(
            { userId },
            { $set: { hasReceivedCoupon: true, claimType: type || 'offline', updatedAt: new Date() } },
            { returnDocument: 'after' }
        );

        // 로그 기록
        await db.collection('game_gimpo_logs').insertOne({
            userId, isMember: !!memberId, result: 'claim', claimType: type || 'offline', createdAt: new Date()
        });

        res.json({ success: true, hasReceivedCoupon: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// GET /api/game/gimpo/successList
router.get('/gimpo/successList', async (req, res) => {
    try {
        const db = getDB();
        const logs = await db.collection('game_gimpo_logs')
            .find({ isMember: true, result: 'success' })
            .sort({ createdAt: -1 }).limit(100).toArray();

        const seen = new Set();
        const uniqueList = [];
        for (const log of logs) {
            if (!seen.has(log.userId)) {
                seen.add(log.userId);
                const id = log.userId;
                const masked = id.length > 3 ? id.slice(0, 3) + '***' : id + '***';
                uniqueList.push(masked);
            }
            if (uniqueList.length >= 50) break;
        }
        res.json({ success: true, list: uniqueList });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, list: [] });
    }
});

// GET /api/game/gimpo/admin/logs
router.get('/gimpo/admin/logs', async (req, res) => {
    try {
        const { date } = req.query;
        const db = getDB();
        const query = { isMember: true };
        if (date) {
            const startOfDay = new Date(`${date}T00:00:00+09:00`);
            const endOfDay = new Date(`${date}T23:59:59.999+09:00`);
            query.createdAt = { $gte: startOfDay, $lte: endOfDay };
        }
        const logs = await db.collection('game_gimpo_logs').find(query).sort({ createdAt: -1 }).toArray();
        res.json({ success: true, logs });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

module.exports = router;