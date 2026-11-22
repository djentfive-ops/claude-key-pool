# Claude 키 묶음 — 업데이트 채널

여러 Claude 계정의 API 크레딧 키를 주소 하나(`http://127.0.0.1:4100`)로 묶어 쓰는 윈도우 앱의 자동 업데이트 저장소입니다.

- `update.json` + `app-<버전>.asar` — 설치된 앱이 6시간마다 이 두 파일을 확인해, 새 버전이면 받아 두었다가 쓰지 않을 때 조용히 적용합니다.
- `prices.json` — 새 모델 가격. 여기만 고쳐서 push 하면 설치된 앱이 6시간 안에 새 가격으로 계산합니다(앱 업데이트 불필요).
- `src/` — 앱 소스. 키·비밀값은 들어 있지 않습니다(키는 각 PC에서 윈도우 암호화로 저장).

## 새 버전 올리기
1. `src/core/` 수정 → `src/core/package.json` 의 `version` 올리기
2. `bash release.sh "바뀐 점 한 줄"`
3. 커밋·push

설치 파일(런타임 포함, 약 110MB)은 Electron 자체를 바꿀 때만 새로 만듭니다:
`cd src && npm i -D electron@45 electron-builder@26 pretendard && npx electron-builder --win dir --x64 && node tools/seticon.mjs dist/win-unpacked/ClaudeKeyPool.exe core/assets/icon.ico <버전> && makensis installer.nsi`
