const express = require('express');
const router = express.Router();
const { getDB } = require('../config/db');

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
        let completedMissions = [];
        let downloadedCoupons = [];

        if (user) {
            hearts = user.hearts;
            hasReceivedCoupon = user.hasReceivedCoupon || false;
            completedMissions = user.completedMissions || [];
            downloadedCoupons = user.downloadedCoupons || [];
        } else {
            // ✅ 초기 수치 설정: 회원 2개, 비회원 1개
            hearts = memberId ? 2 : 1;
            await db.collection('game_detox_users').insertOne({
                userId,
                isMember: !!memberId,
                hearts,
                hasReceivedCoupon: false,
                completedMissions: [],
                downloadedCoupons: [],
                createdAt: new Date(),
                updatedAt: new Date()
            });
        }

        res.json({ success: true, hearts, hasReceivedCoupon, completedMissions, downloadedCoupons });
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
        const { memberId, guestId } = req.body;
        const db = getDB();
        const userId = memberId || guestId;

        if (!userId) {
            return res.status(400).json({ success: false, error: 'userId is required' });
        }

        await db.collection('game_detox_logs').insertOne({
            userId,
            isMember: !!memberId,
            result: 'success',
            createdAt: new Date()
        });

        let hearts = 0;
        let hasReceivedCoupon = false;

        if (memberId) {
            const updated = await db.collection('game_detox_users').findOneAndUpdate(
                { userId },
                {
                    $set: { hasReceivedCoupon: true, updatedAt: new Date() }
                },
                { returnDocument: 'after', upsert: true }
            );
            // ✅ 기존 5로 세팅되던 예외 기본값을 2로 변경
            hearts = updated ? updated.hearts : 2;
            hasReceivedCoupon = true;
        } else {
            const user = await db.collection('game_detox_users').findOne({ userId });
            if (user) hearts = user.hearts;
        }

        res.json({ success: true, hearts, hasReceivedCoupon });
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

// POST /api/game/detox/claim - 상품 수령 처리
router.post('/detox/claim', async (req, res) => {
    try {
        const { memberId, guestId } = req.body;
        const db = getDB();
        const userId = memberId || guestId;

        if (!userId) {
            return res.status(400).json({ success: false, error: 'userId is required' });
        }

        const updated = await db.collection('game_detox_users').findOneAndUpdate(
            { userId },
            {
                $set: { hasReceivedCoupon: true, hearts: 0, updatedAt: new Date() }
            },
            { returnDocument: 'after' }
        );

        res.json({ success: true, hearts: 0, hasReceivedCoupon: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: '서버 에러' });
    }
});

// POST /api/game/detox/fail
router.post('/detox/fail', async (req, res) => {
    try {
        const { memberId, guestId } = req.body;
        const db = getDB();
        const userId = memberId || guestId;

        if (!userId) {
            return res.status(400).json({ success: false, error: 'userId is required' });
        }

        await db.collection('game_detox_logs').insertOne({
            userId,
            isMember: !!memberId,
            result: 'fail',
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

module.exports = router;