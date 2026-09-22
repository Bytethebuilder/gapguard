# Narration wav -> timing.json (scene cut points) + pitch.srt (subtitles), from Whisper word timestamps.
#   python3 timing.py pitch.wav
import json, os, re, subprocess, sys, tempfile
wav = sys.argv[1]
tmp = tempfile.mkdtemp()
env = dict(os.environ, PATH=os.path.expanduser("~/Library/Python/3.9/bin") + ":" + os.environ["PATH"])
subprocess.run(["whisper", wav, "--model", "base.en", "--language", "en", "--word_timestamps", "True",
                "--output_format", "json", "--output_dir", tmp], check=True, capture_output=True, env=env)
segs = json.load(open(os.path.join(tmp, os.path.splitext(os.path.basename(wav))[0] + ".json")))["segments"]
words = [w for s in segs for w in s["words"]]
dur = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", wav],
                           capture_output=True, text=True).stdout)
norm = lambda t: re.sub(r"[^a-z0-9' ]", "", t.lower()).strip()
toks = [norm(w["word"]) for w in words]

def start(*phrases):
    for p in phrases:
        ps = norm(p).split()
        for i in range(len(toks) - len(ps) + 1):
            if toks[i:i + len(ps)] == ps: return round(words[i]["start"], 2)
    raise SystemExit(f"anchor not found: {phrases}")

timing = {
    "story": start("this actually happened", "back in august", "august"),
    "how": start("so i built", "hook that prices"),
    "live": start("when the market's open", "when the markets open", "market's open", "markets open"),
    "sell": start("trading back toward", "restore the peg"),
    "replay": start("i replayed", "replayed", "replaying"),
    "safety": start("it's live", "mainnet"),
    "livePanel": start("robinhood chain is where", "where tokenized"),
    "end": start("i'm david", "air force"),
    "total": round(dur + 1.2, 2),
}
json.dump(timing, open("timing.json", "w"), indent=1)

FIX = [(r"\bhymns and hers\b", "Hims & Hers"), (r"\bhymns\b", "Hims"), (r"\brapper\b", "wrapper"),
       (r"\bGap ?[Gg]uard\b", "Gapguard"), (r"\bmeme coin\b", "memecoin"), (r"\bUniswap (V4|fee for|before)\b", "Uniswap v4"),
       (r"\b24[-.]7\b", "24/7"), (r"\bRobinhood chain\b", "Robinhood Chain"), (r"\bOracle\b", "oracle"),
       (r"\bon chain\b", "on-chain"), (r"\bsources verified\b", "source is verified"), (r"\bmarkets open\b", "market's open")]
def fix(t):
    for a, b in FIX: t = re.sub(a, b, t, flags=re.I)
    return re.sub(r"\s+", " ", t).strip()
def ts(x):
    h, r = divmod(x, 3600); m, s = divmod(r, 60)
    return f"{int(h):02}:{int(m):02}:{int(s):02},{int(round((s - int(s)) * 1000)):03}"
# Subtitle cues: split at sentence ends, or at ~12 words.
cues, cur = [], []
for w in words:
    cur.append(w)
    if re.search(r"[.?!]$", w["word"].strip()) or len(cur) >= 12:
        cues.append(cur); cur = []
if cur: cues.append(cur)
with open("pitch.srt", "w") as f:
    for i, c in enumerate(cues, 1):
        f.write(f"{i}\n{ts(c[0]['start'])} --> {ts(c[-1]['end'] + 0.15)}\n{fix(''.join(w['word'] for w in c))}\n\n")
print(json.dumps(timing))
