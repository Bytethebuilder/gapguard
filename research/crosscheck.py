#!/usr/bin/env python3
"""Independent cross-check of research/closed-market.json for a few pools.

Shares no code with measure.mjs: Python stdlib only, its own log fetching, and market hours from
zoneinfo (America/New_York) plus the NYSE holiday list for the window typed in by hand instead of
web/clock.js. Every swap gets its exact block timestamp (no block-boundary mapping).

    python3 research/crosscheck.py                # re-checks the 3 pools reported in README.md
    python3 research/crosscheck.py <poolId> ...   # or specific pools (USDG-quoted only)
"""
import json, sys, time, urllib.request
from datetime import datetime, date, time as dtime
from pathlib import Path
from zoneinfo import ZoneInfo

RPC = "https://rpc.mainnet.chain.robinhood.com"
PM = "0x8366a39CC670B4001A1121B8F6A443A643e40951"
SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
INIT = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438"
USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"
NY = ZoneInfo("America/New_York")
HOLIDAYS = {date(2026, 9, 7)}  # Labor Day: the only NYSE holiday in the default window; no early closes
HERE = Path(__file__).parent


def rpc(method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    for attempt in range(12):
        try:
            req = urllib.request.Request(RPC, body, {"content-type": "application/json", "user-agent": "crosscheck"})
            out = json.load(urllib.request.urlopen(req, timeout=60))
            if "error" in out:
                msg = out["error"]["message"]
                if "Too Many" in msg:
                    raise RuntimeError(msg)
                return ("ERR", msg)
            return out["result"]
        except Exception:
            time.sleep(min(30, 2 ** attempt))
    raise RuntimeError("rpc failed")


def logs(topics, a, b):
    r = rpc("eth_getLogs", [{"address": PM, "fromBlock": hex(a), "toBlock": hex(b), "topics": topics}])
    if isinstance(r, tuple):  # range refused: split
        m = (a + b) // 2
        return logs(topics, a, m) + logs(topics, m + 1, b)
    return r


def is_open(ts):
    t = datetime.fromtimestamp(ts, NY)
    if t.weekday() >= 5 or t.date() in HOLIDAYS:
        return False
    return dtime(9, 30) <= t.time() < dtime(16, 0)


def s128(h):
    v = int(h, 16)
    return v - (1 << 256) if v >= 1 << 255 else v


def main():
    res = json.loads((HERE / "closed-market.json").read_text())
    w = res["window"]
    pools = sys.argv[1:] or [
        "0xcd5c9e43b3ae2cbfc806f9982183b77e2a480f12460af78b674ea30739bd358a",  # NVDA/USDG
        "0xf5666332afeeb7228d2a611f73032f5f4ad4a53b0d50150c6ee5e39276854935",  # SPY/USDG
        "0x3b011694a078de11a0bfc42bb9043aade1348446ff83d5cefa1c1e52da145c4a",  # GOOGL/USDG
    ]
    for pid in pools:
        init = logs([INIT, pid], 0, w["toBlock"])[0]
        c0, c1 = "0x" + init["topics"][2][26:], "0x" + init["topics"][3][26:]
        assert USDG in (c0, c1), "USDG pools only"
        usdg_is0 = c0 == USDG
        sw = []
        a = w["fromBlock"]
        while a <= w["toBlock"]:
            b = min(w["toBlock"], a + 500_000 - 1)
            sw += logs([SWAP, pid], a, b)
            a = b + 1
        blocks = sorted({int(l["blockNumber"], 16) for l in sw})
        ts = {}
        for i in range(0, len(blocks), 25):
            chunk = blocks[i:i + 25]
            body = json.dumps([{"jsonrpc": "2.0", "id": j, "method": "eth_getBlockByNumber", "params": [hex(n), False]} for j, n in enumerate(chunk)]).encode()
            got = {}
            for attempt in range(20):
                time.sleep(0.15)
                try:
                    out = json.load(urllib.request.urlopen(urllib.request.Request(RPC, body, {"content-type": "application/json", "user-agent": "crosscheck"}), timeout=60))
                    got = {r["id"]: int(r["result"]["timestamp"], 16) for r in out if r.get("result")}
                    if len(got) == len(chunk):
                        break
                except Exception:
                    pass
                time.sleep(min(30, 2 ** attempt))
            if len(got) != len(chunk):
                raise RuntimeError(f"could not fetch timestamps for blocks {chunk[0]}..{chunk[-1]}")
            for j, n in enumerate(chunk):
                ts[n] = got[j]
        n = closed = 0
        usd = usd_closed = 0.0
        for l in sw:
            d = l["data"][2:]
            a0, a1 = s128(d[0:64]), s128(d[64:128])
            v = abs(a0 if usdg_is0 else a1) / 1e6
            n += 1
            usd += v
            if not is_open(ts[int(l["blockNumber"], 16)]):
                closed += 1
                usd_closed += v
        mine = next(p for p in res["topPools"] if p["pool"] == pid)
        print(f"{mine['ticker']}/USDG {pid[:10]}…")
        print(f"  crosscheck : swaps {n}  closed {closed}  usd {usd:,.0f}  usdClosed {usd_closed:,.0f}")
        print(f"  measure.mjs: swaps {mine['swaps']}  closed {mine['swapsClosed']}  usd {mine['usd']:,}  usdClosed {mine['usdClosed']:,}")


if __name__ == "__main__":
    main()
