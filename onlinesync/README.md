# onlinesync — onlineData 일일 동기화 (ychat 호스팅)

분석 대시보드(onlineData, Vercel 배포)는 **읽기 전용/서버리스**라 무거운 수집·쿠폰 스캔을 못 돌립니다.
이 폴더는 그 **수집·캐시 워밍 로직을 ychat(상시 켜진 Cloudtype 서버) 안에 얹어** 매일 자동 실행하기 위한 것입니다.

## 동작
- `cron.js` 가 ychat `server.js` 에서 한 줄(`require("./onlinesync/cron")`)로 로드됩니다.
- `ENABLE_ONLINE_SYNC=1` 일 때만, **매일 00:05(KST)** 에 `scripts/daily-sync.js` 를 **별도 자식 프로세스**로 실행합니다.
  - 자식 프로세스라 ychat 본체의 메모리/이벤트루프/타임존에 영향이 없습니다.
  - 자식에 `TZ=Asia/Seoul` 을 주입해 날짜 계산이 KST 로 정확합니다.
- 하는 일: 최근 7일 **Cafe24 + 스마트스토어 주문 적재** → 자주 보는 구간(이번달·최근30일·지난달·최근 프로모션)의 **overview + 쿠폰 funnel 캐시 워밍**.
- 결과는 onlineData 분석 DB(`onlinedata`)에 저장 → Vercel 대시보드가 그 캐시를 즉시 읽어 빠르게 응답합니다.

## Cloudtype 환경변수 (ychat 서비스에 추가)
> ✅ **대부분 ychat 기존 변수에서 자동 파생됩니다.** (검증됨: ychat `MONGODB_URI`=onlineData 데이터 클러스터(cluster0), `DB_NAME`=`yogibo`=토큰 DB, `CAFE24_MALLID`=`yogibo`)
> `cron.js` 가 자식 프로세스에 `ONLINEDATA_URI←MONGODB_URI`, `CAFE24_TOKEN_URI←MONGODB_URI`, `CAFE24_TOKEN_DB←DB_NAME`, `CAFE24_MALL_ID←CAFE24_MALLID` 로 매핑합니다.

**그래서 실제로 추가할 변수는 이것뿐:**

| 변수 | 값 | 필수? | 비고 |
|---|---|---|---|
| `ENABLE_ONLINE_SYNC` | `1` | **필수** | 이 값이 1일 때만 매일 00:05(KST) 크론 활성 |
| `NAVER_COMMERCE_CLIENT_ID` | (네이버 커머스) | 권장 | 스마트스토어 동기화용. 없으면 Cafe24만 하고 SS는 건너뜀 |
| `NAVER_COMMERCE_CLIENT_SECRET` | (네이버 커머스) | 권장 | |
| `ONLINE_SYNC_ON_BOOT` | `1` | 선택 | 배포/재시작 직후 1회 즉시 실행 — **최초 1번만 확인용**, 평소엔 끄기 |
| `ONLINE_SYNC_DAYS` | `7` | 선택 | 적재 일수(기본 7) |

> 만약 ychat 의 Mongo/토큰 위치가 바뀌면, 아래 변수를 명시로 덮어쓸 수 있습니다(설정 시 자동매핑보다 우선):
> `ONLINEDATA_URI`, `ONLINEDATA_DB`, `CAFE24_TOKEN_URI`, `CAFE24_TOKEN_DB`, `CAFE24_TOKEN_COLLECTION`, `CAFE24_MALL_ID`, `CAFE24_API_VERSION`

## 끄기 / 안전장치
- `ENABLE_ONLINE_SYNC` 를 빼거나 `0` 으로 → 즉시 비활성(크론 예약 안 함).
- `cron.js` 로드는 ychat `server.js` 에서 try/catch 로 감싸져 있어, 어떤 오류도 챗 기동을 막지 않습니다.
- 동기화는 별도 프로세스에서 돌고, 이전 실행이 안 끝났으면 다음 트리거는 자동 스킵됩니다.

## 코드 출처 / 업데이트
`lib/`, `config/`, `scripts/` 는 **onlineData 프로젝트의 사본(vendored)** 입니다.
onlineData 쪽 로직이 바뀌면 그 폴더의 `lib/ config/ scripts/{daily-sync,warm}.js` 를 다시 복사해 동기화하세요.

## 로컬 테스트
ychat 폴더에 임시 `onlinesync/.env`(gitignore됨)를 두거나, 더 간단히는 onlineData 프로젝트에서 직접:
```
cd onlineData && node scripts/daily-sync.js
```
