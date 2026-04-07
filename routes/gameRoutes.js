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

        if (user) {
            hearts = user.hearts;
            hasReceivedCoupon = user.hasReceivedCoupon || false;
            completedMissions = user.completedMissions || [];
        } else {
            // 초기 수치 설정
            hearts = memberId ? 5 : 1; 
            await db.collection('game_detox_users').insertOne({
                userId,
                isMember: !!memberId,
                hearts,
                hasReceivedCoupon: false,
                completedMissions: [],
                createdAt: new Date(),
                updatedAt: new Date()
            });
        }

        res.json({ success: true, hearts, hasReceivedCoupon, completedMissions });
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

        const newHearts = updated ? Math.min(updated.hearts, 5) : 5;

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
            hearts = updated ? updated.hearts : 5;
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

module.exports = router;
