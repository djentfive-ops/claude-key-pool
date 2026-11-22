#!/bin/bash
# 새 버전 올리기: src/core/package.json 의 version 을 올린 뒤
#   bash release.sh "바뀐 점 한 줄"
# → app-<버전>.asar + update.json 을 만든다. 커밋·push 하면 설치된 앱들이 6시간 안에 알아서 받는다.
set -e
cd "$(dirname "$0")"
V=$(node -p "require('./src/core/package.json').version")
NOTES=${1:-"기능 개선"}
rm -f app-*.asar
npx --yes @electron/asar pack src/core "app-$V.asar"
SHA=$(sha256sum "app-$V.asar" | cut -d' ' -f1)
node -e "require('fs').writeFileSync('update.json', JSON.stringify({version:'$V',file:'app-$V.asar',sha256:'$SHA',notes:process.argv[1]}, null, 2)+'\n')" "$NOTES"
cat update.json
