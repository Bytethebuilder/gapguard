# Gemini TTS: text file -> wav. Reads GEMINI_API_KEY from ~/Documents/ByteBox LLC/.env (never printed).
import base64, json, os, sys, subprocess, urllib.request
def key():
    for line in open(os.path.expanduser("~/Documents/ByteBox LLC/.env")):
        if line.startswith("GEMINI_API_KEY="): return line.split("=",1)[1].strip().strip('"').strip("'")
text = open(sys.argv[1]).read(); out = sys.argv[2]; voice = sys.argv[3] if len(sys.argv) > 3 else "Charon"
model = os.environ.get("TTS_MODEL", "gemini-2.5-flash-preview-tts")
body = {"contents":[{"parts":[{"text": text}]}],
        "generationConfig":{"responseModalities":["AUDIO"],"speechConfig":{"voiceConfig":{"prebuiltVoiceConfig":{"voiceName":voice}}}}}
req = urllib.request.Request(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
      data=json.dumps(body).encode(), headers={"Content-Type":"application/json","x-goog-api-key":key()})
try:
    r = json.load(urllib.request.urlopen(req, timeout=300))
except urllib.error.HTTPError as e:
    print("HTTP", e.code, e.read().decode()[:400]); sys.exit(1)
pcm = base64.b64decode(r["candidates"][0]["content"]["parts"][0]["inlineData"]["data"])
open(out + ".pcm","wb").write(pcm)
subprocess.run(["ffmpeg","-y","-loglevel","error","-f","s16le","-ar","24000","-ac","1","-i",out+".pcm",out], check=True)
os.remove(out + ".pcm"); print("ok", out)
