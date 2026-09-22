#!/usr/bin/env bash
# Records demo-live.mp4: the deployed hook in action on a local fork of Robinhood Chain mainnet.
set -euo pipefail
cd "$(dirname "$0")"
FORK_PORT=8547; SITE_PORT=4898
ME=0xc8Ef9472bB630d1Eb31CBeE25DE8d12d07710e0B
SAT=1790434800   # Sat 2026-09-26 15:00 UTC — market closed
anvil --fork-url https://rpc.mainnet.chain.robinhood.com --port $FORK_PORT --silent & ANVIL=$!
trap 'kill $ANVIL $SERVER 2>/dev/null || true' EXIT
for i in $(seq 1 30); do cast block-number --rpc-url http://127.0.0.1:$FORK_PORT >/dev/null 2>&1 && break; sleep 1; done
R=http://127.0.0.1:$FORK_PORT
cast rpc evm_setNextBlockTimestamp $SAT --rpc-url $R >/dev/null && cast rpc evm_mine --rpc-url $R >/dev/null
cast rpc anvil_impersonateAccount $ME --rpc-url $R >/dev/null
cast rpc anvil_setBalance $ME 0x56BC75E2D63100000 --rpc-url $R >/dev/null
# Local copy of the site pointed at the fork, refreshing every 2 s.
SITE_DIR=$(mktemp -d); cp -R ../../web/. "$SITE_DIR"/
sed -i '' "s#rpc: \"https://rpc.mainnet.chain.robinhood.com\"#rpc: \"$R\"#" "$SITE_DIR/config.js"
sed -i '' 's/setTimeout(poll, 15000)/setTimeout(poll, 2000)/' "$SITE_DIR/app.js"
(cd "$SITE_DIR" && python3 -m http.server $SITE_PORT >/dev/null 2>&1) & SERVER=$!
sleep 1
echo "market open on fork: $(cast call 0x17DaD741593cEf7801c8C80c92Bb987766cA90C4 'isMarketOpen()(bool)' --rpc-url $R)"
RAW=$(SITE=http://localhost:$SITE_PORT FORK=$R node record-live.cjs | tail -1)
ffmpeg -y -loglevel error -ss 0.5 -i "$RAW" -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart -r 30 demo-live.mp4
ffprobe -v error -show_entries format=duration -of csv=p=0 demo-live.mp4
