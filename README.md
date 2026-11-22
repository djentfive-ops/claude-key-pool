# OVIS Gate(오비스 게이트) — 업데이트 채널

여러 계정의 Claude·GPT API 키를 주소 하나(`http://127.0.0.1:4100`)로 묶어 쓰는 OVIS Studio 윈도우 앱의 자동 업데이트 저장소입니다.
1.5.0 까지의 이름은 「Claude 키 묶음」이었습니다. 저장소 이름·설치 폴더·저장 폴더·Render 서비스 이름(`claude-keypool`)은 이어지도록 그대로 둡니다.

- `update.json` + `app-<버전>.asar` — 설치된 앱이 6시간마다 이 두 파일을 확인해, 새 버전이면 받아 두었다가 쓰지 않을 때 조용히 적용합니다.
- `prices.json` — 새 모델 가격. 여기만 고쳐서 push 하면 설치된 앱이 6시간 안에 새 가격으로 계산합니다(앱 업데이트 불필요).
- `src/` — 앱 소스. 키·비밀값은 들어 있지 않습니다(키는 각 PC에서 윈도우 암호화로 저장).

## 새 버전 올리기
1. `src/core/` 수정 → `src/core/package.json` 의 `version` 올리기
2. `bash release.sh "바뀐 점 한 줄"`
3. 커밋·push

설치 파일(런타임 포함, 약 110MB)은 Electron 자체를 바꿀 때만 새로 만듭니다:
`cd src && npm i -D electron@45 electron-builder@26 pretendard && npx electron-builder --win dir --x64 && node tools/seticon.mjs dist/win-unpacked/ClaudeKeyPool.exe core/assets/icon.ico <버전> && makensis installer.nsi`

## 게이트 서버 (`server/`)
오비스 서버가 Claude·GPT 를 부를 때 거치는 OVIS Gate 서버입니다. Render 에서 24시간 돌고, PC 가 꺼져 있어도 상관없습니다.
관리는 PC 앱의 **서버 연결**(주소 + 관리 토큰)로 합니다.

- 배포: Render → New → Blueprint → 이 저장소 → `render.yaml` 그대로(싱가포르, 항상 켜진 인스턴스 + 1GB 디스크)
- 환경변수(자동 생성): `ADMIN_TOKEN`(앱 연결용), `PROXY_TOKEN`(오비스 서버의 API 키 칸에 넣는 값), `KEYPOOL_SECRET`(키 암호화)
- 오비스 서버 쪽: `ANTHROPIC_BASE_URL=<서버 주소>`, `OPENAI_BASE_URL=<서버 주소>/v1`, `ANTHROPIC_API_KEY`·`OPENAI_API_KEY` = `PROXY_TOKEN`
- 요청 내용은 저장하지 않습니다(모델·토큰 수·요금·결과 상태만 기록).
- 게이트가 직접 낸 응답에는 항상 `x-keypool: 1` 헤더가 붙습니다(이름을 바꿔도 이 헤더 이름은 그대로). 이 헤더 없이 502·503·504 가 오면 게이트가 꺼져 있는 것(배포 중 등)이니, 받는 쪽은 그때만 직접 키로 재시도하면 됩니다.
- 같은 키가 PC 앱과 서버에 다 있으면(종류+끝 4자리로 짝지음) 앱이 남은 크레딧을 하나로 맞춘다: 한 번 맞춘 기준 금액에서 PC 사용액과 서버 사용액을 함께 뺀다. 공식 잔액 API 가 없어서 쓰는 방법.
- 실제 사용액 자동 연동(PC 앱): 공식 비용 보고서(Anthropic `cost_report`, OpenAI `organization/costs`)로 이번 주기 실제 사용액을 10분마다 읽어 남은 크레딧을 맞춘다. 지금 키로 먼저 시도하고, 안 되면 계정별 관리자 키(PC 에만 암호화 저장)를 쓴다.
- 서버는 `TZ=Asia/Seoul` — 충전일·"오늘"을 PC 앱과 같은 한국 시간으로 센다.
- `server/lib/` 는 앱의 `src/core/` 에서 복사한 공용 엔진입니다(`proxy-core.js`, `pricing.js`, `usage-store.js`).
