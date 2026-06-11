'use strict';

/**
 * 월별 채널 목표 매출 (원). 숫자만 수정하면 됨.
 * 해당 월 키가 없으면 default 사용. (레퍼런스 기준 기본값)
 */
module.exports = {
  monthly: {
    '2026-06': { cafe24: 127000000, smartstore: 50000000 },
    '2026-05': { cafe24: 127000000, smartstore: 50000000 },
  },
  default: { cafe24: 127000000, smartstore: 50000000 },
};
