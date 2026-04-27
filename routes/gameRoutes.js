const express = require('express');
const router = express.Router();
const { getDB } = require('../config/db');

// GET /api/game/detox/config - 성공 범위를 DB에서 가져오게 추가
router.get('/detox/config', async (req, res) => {
    try {
        const db = getDB();
        const config = await db.collection('game_detox_config').findOne({ type: 'success_criteria' });
        if (config) {
            res.json({ success: true, minTime: config.minTime, maxTime: config.maxTime, missions: config.missions || [], baseHearts: config.baseHearts !== undefined ? config.baseHearts : 2 });
        } else {
            // 기본값
            res.json({ success: true, minTime: 10000, maxTime: 11000, missions: [], baseHearts: 2 });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// POST /api/game/detox/config - 관리자가 성공 범위를 수정
router.post('/detox/config', async (req, res) => {
    try {
        const { minTime, maxTime, baseHearts, missions } = req.body;
        const db = getDB();

        await db.collection('game_detox_config').updateOne(
            { type: 'success_criteria' },
            {
                $set: {
                    minTime: parseInt(minTime),
                    maxTime: parseInt(maxTime),
                    baseHearts: parseInt(baseHearts) || 2,
                    missions: missions || [],
                    updatedAt: new Date()
                }
            },
            { upsert: true }
        );
        res.json({ success: true, minTime, maxTime, baseHearts, missions });
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
        const config = await db.collection('game_detox_config').findOne({ type: 'success_criteria' });
        const baseHeartsForMember = (config && config.baseHearts !== undefined) ? config.baseHearts : 2;

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

            // ✅ 회원인데 미션 없이 hearts > baseHeartsForMember인 경우 (과거 잘못 초기화된 데이터 보정)
            // 미션으로 하트를 추가한 적 없는(completedMissions가 비어있는) 회원이
            // baseHeartsForMember개를 초과하는 hearts를 가진 경우 baseHeartsForMember개로 재조정
            if (memberId && completedMissions.length === 0 && hearts > baseHeartsForMember) {
                hearts = baseHeartsForMember;
                await db.collection('game_detox_users').updateOne(
                    { userId },
                    { $set: { hearts: baseHeartsForMember, isMember: true, updatedAt: new Date() } }
                );
            } else if (memberId && !user.isMember) {
                // 비회원 → 회원 전환 감지: isMember 플래그 업데이트
                await db.collection('game_detox_users').updateOne(
                    { userId },
                    { $set: { isMember: true, updatedAt: new Date() } }
                );
            }
        } else {
            // ✅ 초기 수치 설정: 회원 설정값, 비회원 1개
            hearts = memberId ? baseHeartsForMember : 1;
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

        let hasReceivedSecretCoupon = false;
        // 3000원 적립금(선물상자) 수령 여부 확인하여 쿠폰 상태 반영
        if (memberId) {
            const rewardLog = await db.collection('detox_event_point_onOff').findOne({ memberId });
            if (rewardLog) {
                hasReceivedSecretCoupon = true;
            }
        }

        res.json({ success: true, hearts, hasReceivedCoupon, hasReceivedOnlineCoupon, hasReceivedSecretCoupon, completedMissions, downloadedCoupons });
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
        const user = await db.collection('game_detox_users').findOne({ userId });

        // 카카오 공유(idx 0)가 아닌 미션은 중복 참여 불가
        if (missionIdx !== 0 && user && user.completedMissions && user.completedMissions.includes(missionIdx)) {
            return res.json({ success: false, error: 'already_completed', message: '이미 참여 완료한 미션입니다.', completedMissions: user.completedMissions });
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

        const newHearts = updated ? updated.hearts : (user ? user.hearts + reward : reward);

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
        const { memberId } = req.query;
        const db = getDB();

        // 1. 총 성공 횟수
        const totalSuccessCount = await db.collection('game_detox_logs').countDocuments({ isMember: true, result: 'success' });

        // 2. 유별자 별 성공 횟수 집계 (최근 성공 기준 내림차순)
        const aggregateLogs = await db.collection('game_detox_logs').aggregate([
            { $match: { isMember: true, result: 'success' } },
            { $group: { _id: "$userId", count: { $sum: 1 }, latestSuccess: { $max: "$createdAt" } } },
            { $sort: { count: -1, latestSuccess: -1 } }
        ]).toArray();

        let myCount = 0;
        let myRank = null;
        if (memberId) {
            const myIndex = aggregateLogs.findIndex(log => log._id === memberId);
            if (myIndex !== -1) {
                myRank = myIndex + 1;
                myCount = aggregateLogs[myIndex].count;
            }
        }

        const top50 = aggregateLogs.slice(0, 50);

        const list = top50.map(log => {
            const id = log._id;
            const masked = id.length > 3 ? id.slice(0, 3) + '***' : id + '***';
            return { id: masked, count: log.count };
        });

        res.json({ success: true, list, totalSuccessCount, myCount, myRank });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, list: [], totalSuccessCount: 0, myCount: 0, myRank: null });
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
            res.json({ success: true, minTime: config.minTime, maxTime: config.maxTime, missions: config.missions || [], baseHearts: config.baseHearts !== undefined ? config.baseHearts : 2 });
        } else {
            res.json({ success: true, minTime: 10000, maxTime: 11000, missions: [], baseHearts: 2 });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// POST /api/game/gimpo/config
router.post('/gimpo/config', async (req, res) => {
    try {
        const { minTime, maxTime, baseHearts, missions } = req.body;
        const db = getDB();
        await db.collection('game_gimpo_config').updateOne(
            { type: 'success_criteria' },
            {
                $set: {
                    minTime: parseInt(minTime),
                    maxTime: parseInt(maxTime),
                    baseHearts: parseInt(baseHearts) || 2,
                    missions: missions || [],
                    updatedAt: new Date()
                }
            },
            { upsert: true }
        );
        res.json({ success: true, minTime, maxTime, baseHearts, missions });
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
        const config = await db.collection('game_gimpo_config').findOne({ type: 'success_criteria' });
        const baseHeartsForMember = (config && config.baseHearts !== undefined) ? config.baseHearts : 2;

        let hearts = 0, hasReceivedCoupon = false, hasReceivedOnlineCoupon = false;
        let completedMissions = [], downloadedCoupons = [];

        if (user) {
            hearts = user.hearts;
            hasReceivedCoupon = user.hasReceivedCoupon || false;
            hasReceivedOnlineCoupon = user.hasReceivedOnlineCoupon || false;
            completedMissions = user.completedMissions || [];
            downloadedCoupons = user.downloadedCoupons || [];

            if (memberId && completedMissions.length === 0 && hearts > baseHeartsForMember) {
                hearts = baseHeartsForMember;
                await db.collection('game_gimpo_users').updateOne({ userId }, { $set: { hearts: baseHeartsForMember, isMember: true, updatedAt: new Date() } });
            } else if (memberId && !user.isMember) {
                await db.collection('game_gimpo_users').updateOne({ userId }, { $set: { isMember: true, updatedAt: new Date() } });
            }
        } else {
            hearts = memberId ? baseHeartsForMember : 1;
            await db.collection('game_gimpo_users').insertOne({
                userId, isMember: !!memberId, hearts,
                hasReceivedCoupon: false, hasReceivedOnlineCoupon: false,
                completedMissions: [], downloadedCoupons: [],
                createdAt: new Date(), updatedAt: new Date()
            });
        }

        let hasReceivedSecretCoupon = false;
        // 3000원 적립금(선물상자) 수령 여부 확인하여 쿠폰 상태 반영
        if (memberId) {
            const rewardLog = await db.collection('gimpo_event_point').findOne({ memberId });
            if (rewardLog) {
                hasReceivedSecretCoupon = true;
            }
        }
        res.json({ success: true, hearts, hasReceivedCoupon, hasReceivedOnlineCoupon, hasReceivedSecretCoupon, completedMissions, downloadedCoupons });
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

        // 카카오 공유(idx 0)가 아닌 미션은 중복 참여 불가
        if (missionIdx !== 0 && user && user.completedMissions && user.completedMissions.includes(missionIdx)) {
            return res.json({ success: false, error: 'already_completed', message: '이미 참여 완료한 미션입니다.', completedMissions: user.completedMissions });
        }

        const updated = await db.collection('game_gimpo_users').findOneAndUpdate(
            { userId: memberId },
            { $addToSet: { completedMissions: missionIdx }, $inc: { hearts: reward }, $set: { updatedAt: new Date() } },
            { returnDocument: 'after', upsert: true }
        );
        const newHearts = updated ? updated.hearts : (user ? user.hearts + reward : reward);
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
        const { memberId } = req.query;
        const db = getDB();

        const totalSuccessCount = await db.collection('game_gimpo_logs').countDocuments({ isMember: true, result: 'success' });

        const aggregateLogs = await db.collection('game_gimpo_logs').aggregate([
            { $match: { isMember: true, result: 'success' } },
            { $group: { _id: "$userId", count: { $sum: 1 }, latestSuccess: { $max: "$createdAt" } } },
            { $sort: { count: -1, latestSuccess: -1 } }
        ]).toArray();

        let myCount = 0;
        let myRank = null;
        if (memberId) {
            const myIndex = aggregateLogs.findIndex(log => log._id === memberId);
            if (myIndex !== -1) {
                myRank = myIndex + 1;
                myCount = aggregateLogs[myIndex].count;
            }
        }

        const top50 = aggregateLogs.slice(0, 50);

        const list = top50.map(log => {
            const id = log._id;
            const masked = id.length > 3 ? id.slice(0, 3) + '***' : id + '***';
            return { id: masked, count: log.count };
        });

        res.json({ success: true, list, totalSuccessCount, myCount, myRank });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, list: [], totalSuccessCount: 0, myCount: 0, myRank: null });
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

// ============================================================
// mk 기기 게임 통계 라우트 (game_mk_logs 컬렉션)
// ============================================================

// POST /api/game/mk/play - 게임 버튼 클릭 기록
router.post('/mk/play', async (req, res) => {
    try {
        const { result, recordTime } = req.body; // result: 'start'|'success'|'fail'
        const db = getDB();

        const nowKST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
        const dateStr = nowKST.toISOString().slice(0, 10); // YYYY-MM-DD

        await db.collection('game_mk_logs').insertOne({
            result: result || 'start',
            recordTime: recordTime || null,
            date: dateStr,
            createdAt: nowKST
        });

        res.json({ success: true });
    } catch (err) {
        console.error('[mk-game] play 기록 오류:', err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// GET /api/game/mk/stats - 전체 통계 + 날짜별 집계
router.get('/mk/stats', async (req, res) => {
    try {
        const db = getDB();

        const [total, success, fail, dailyRaw] = await Promise.all([
            db.collection('game_mk_logs').countDocuments({ result: 'start' }),
            db.collection('game_mk_logs').countDocuments({ result: 'success' }),
            db.collection('game_mk_logs').countDocuments({ result: 'fail' }),
            db.collection('game_mk_logs').aggregate([
                {
                    $group: {
                        _id: '$date',
                        total: { $sum: { $cond: [{ $eq: ['$result', 'start'] }, 1, 0] } },
                        success: { $sum: { $cond: [{ $eq: ['$result', 'success'] }, 1, 0] } },
                        fail: { $sum: { $cond: [{ $eq: ['$result', 'fail'] }, 1, 0] } }
                    }
                },
                { $sort: { _id: -1 } }
            ]).toArray()
        ]);

        const lastLog = await db.collection('game_mk_logs').findOne({}, { sort: { createdAt: -1 } });

        res.json({
            success: true,
            total, success, fail,
            lastPlayed: lastLog ? lastLog.createdAt : null,
            daily: dailyRaw.map(d => ({ date: d._id, total: d.total, success: d.success, fail: d.fail }))
        });
    } catch (err) {
        console.error('[mk-game] stats 조회 오류:', err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

module.exports = router;