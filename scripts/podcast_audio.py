"""🎧 5분 브리핑 음성 파일: 오늘 앵커 대본(brief.podcast)을 Gemini 음성 합성으로 MP3 한 개로 만든다.

왜: 브라우저 내장 음성(speechSynthesis)은 폰 화면이 꺼지거나 다른 앱으로 가면 브라우저가 멈춰 버린다.
진짜 오디오 파일이면 음악 앱처럼 잠금 화면에서도 계속 재생되고, 잠금 화면 조작(재생·건너뛰기)도 된다.

- 배포(deploy.yml) 때 실행. 결과는 web/public/audio/ (저장소에 커밋하지 않음 — Actions 캐시로만 보관).
- 대본이 같으면 다시 만들지 않는다(해시 비교). 하루 보통 1회 호출.
- 키가 없거나 실패하면 아무 파일도 안 만들고 0으로 끝난다 → 화면은 예전처럼 폰 음성으로 읽는다.
- 소식별 시작 시각(챕터)은 글자 수 비율로 추정한 뒤, 그 근처의 가장 긴 쉼(무음)에 맞춘다.

사용: python scripts/podcast_audio.py [--key]   (--key: 캐시 키로 쓸 대본 해시만 출력)
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import sys
import time
from array import array
from datetime import datetime, timezone
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "web" / "public" / "data"
OUT = ROOT / "web" / "public" / "audio"
API = "https://generativelanguage.googleapis.com/v1beta"
VERSION = 1  # 읽는 방식(문구·목소리·지시문)을 바꾸면 올림 → 다시 만듦

# 앞에서부터 써 보고, 목록에 없으면 키로 쓸 수 있는 음성 합성 모델(이름에 tts)을 자동으로 찾는다
MODELS = ["gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"]
VOICE = "Kore"
STYLE = ("다음은 뉴질랜드 오클랜드에 사는 한국인을 위한 아침 뉴스 브리핑 대본입니다. "
         "라디오 뉴스 앵커처럼 차분하고 또렷하게, 너무 빠르지 않게 읽어 주세요. 소식이 바뀌는 곳에서는 잠깐 쉬어 주세요.")
MAX_CHARS = 3500  # 한 번에 보낼 대본 길이(넘으면 소식 단위로 나눠 여러 번)
KBPS = 48


def log(msg: str) -> None:
    print(f"[podcast-audio] {msg}", flush=True)


def latest_brief() -> dict | None:
    p = DATA / "latest.json"
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None


def speakable(s: str) -> str:
    """화면 플레이어(listen.ts speakable)와 같은 규칙으로 읽기 좋게."""
    s = re.sub(r"https?://\S+", "", str(s or ""))
    s = re.sub("[\U0001F000-\U0001FAFF☀-➿️‍]", "", s)
    s = re.sub(r"(\d)\s*~\s*(\d)", r"\1에서 \2", s)
    s = re.sub(r"(\d)\s*%", r"\1퍼센트", s)
    s = re.sub(r"NZ\$\s?", "뉴질랜드 달러 ", s)
    s = re.sub(r"[·•|]", ", ", s)
    s = re.sub(r"👉|→", ", ", s)
    return re.sub(r"\s+", " ", s).strip()


def chapters(brief: dict) -> list[dict]:
    """화면의 podcastTracks 와 같은 순서·제목: 시작 · 소식들 · 마무리"""
    pc = brief.get("podcast") or {}
    segs = pc.get("segments") or []
    if not segs:
        return []
    out = [{"title": "오늘의 브리핑 시작", "text": speakable(pc.get("intro", ""))}]
    for i, s in enumerate(segs):
        text = speakable(s.get("text", ""))
        if i > 0 and not re.match(r"^(먼저|이어서)", text):
            text = "다음 소식입니다. " + text
        out.append({"title": f"{'오클랜드' if s.get('region') == 'akl' else '뉴질랜드'} · {s.get('title', '')}", "text": text})
    out.append({"title": "마무리", "text": speakable(pc.get("outro", ""))})
    return [c for c in out if c["text"]]


def script_hash(brief: dict, chs: list[dict]) -> str:
    raw = json.dumps({"v": VERSION, "voice": VOICE, "style": STYLE, "date": brief.get("date"), "ch": chs}, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]


def pick_models(client: httpx.Client, key: str) -> list[str]:
    names: list[str] = []
    try:
        r = client.get(f"{API}/models", params={"pageSize": 1000}, headers={"x-goog-api-key": key})
        r.raise_for_status()
        for m in r.json().get("models", []):
            n = str(m.get("name", "")).removeprefix("models/")
            if "tts" in n and "generateContent" in (m.get("supportedGenerationMethods") or []):
                names.append(n)
    except Exception as e:  # noqa: BLE001 — 목록을 못 읽으면 기본 목록으로 시도
        log(f"model list failed: {type(e).__name__}")
    pref = [m for m in MODELS if not names or m in names]
    rest = sorted((n for n in names if n not in pref), key=lambda n: (0 if "flash" in n else 1, n), reverse=False)
    return (pref + rest) or MODELS


def synth(client: httpx.Client, key: str, models: list[str], text: str) -> tuple[bytes, int, str]:
    """대본 한 덩어리 → (16비트 모노 PCM, 샘플레이트, 쓴 모델)"""
    body = {
        "contents": [{"parts": [{"text": f"{STYLE}\n\n{text}"}]}],
        "generationConfig": {"responseModalities": ["AUDIO"],
                             "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": VOICE}}}},
    }
    last = ""
    for model in models:
        for attempt in range(3):
            try:
                r = client.post(f"{API}/models/{model}:generateContent", headers={"x-goog-api-key": key}, json=body)
            except httpx.HTTPError as e:
                last = f"{model}: {type(e).__name__}"
                time.sleep(5 * (attempt + 1))
                continue
            if r.status_code == 429 or r.status_code >= 500:
                last = f"{model}: HTTP {r.status_code}"
                if r.status_code == 429 and "PerDay" in r.text:
                    break  # 하루 한도 → 다음 모델
                time.sleep(20 * (attempt + 1))
                continue
            if r.status_code >= 400:
                last = f"{model}: HTTP {r.status_code}"
                break  # 이 모델은 안 됨(이름 바뀜 등) → 다음 모델
            try:
                part = r.json()["candidates"][0]["content"]["parts"][0]["inlineData"]
                pcm = base64.b64decode(part["data"])
                m = re.search(r"rate=(\d+)", part.get("mimeType", ""))
                if len(pcm) < 2000:
                    raise ValueError("audio too short")
                return pcm, int(m.group(1)) if m else 24000, model
            except Exception as e:  # noqa: BLE001
                last = f"{model}: bad response ({type(e).__name__})"
                break
    raise RuntimeError(last or "no model")


def groups(chs: list[dict]) -> list[list[int]]:
    """챕터를 순서대로 MAX_CHARS 이하 묶음으로"""
    out: list[list[int]] = [[]]
    size = 0
    for i, c in enumerate(chs):
        if out[-1] and size + len(c["text"]) > MAX_CHARS:
            out.append([])
            size = 0
        out[-1].append(i)
        size += len(c["text"]) + 2
    return out


def silences(samples: array, rate: int, min_ms: int = 250) -> list[tuple[float, float]]:
    """(시작초, 길이초) 무음 구간 목록: 20ms 창의 평균 크기가 아주 작은 곳"""
    win = max(1, rate // 50)
    peak = max((abs(x) for x in samples[:: max(1, len(samples) // 20000)]), default=1) or 1
    thr = peak * 0.02
    out, start = [], None
    for k in range(0, len(samples) - win, win):
        seg = samples[k:k + win:4]
        quiet = (sum(abs(x) for x in seg) / max(1, len(seg))) < thr
        if quiet and start is None:
            start = k
        elif not quiet and start is not None:
            if (k - start) * 1000 / rate >= min_ms:
                out.append((start / rate, (k - start) / rate))
            start = None
    return out


def place_chapters(chs: list[dict], idx: list[int], offset: float, dur: float, gaps: list[tuple[float, float]]) -> None:
    """한 묶음 안의 챕터 시작 시각: 글자 비율로 추정 → ±5초 안의 가장 긴 쉼 끝으로 맞춤"""
    total = sum(len(chs[i]["text"]) for i in idx) or 1
    acc, prev = 0, 0.0
    for n, i in enumerate(idx):
        if n == 0:
            chs[i]["start"] = round(offset, 2)
        else:
            est = dur * acc / total
            near = [g for g in gaps if g[0] + g[1] > prev + 0.5 and abs(g[0] + g[1] / 2 - est) <= 5]
            t = est
            if near:   # 충분히 긴 쉼(가장 긴 쉼의 60% 이상) 중 추정 시각에 가장 가까운 것
                top = max(g[1] for g in near)
                g = min((g for g in near if g[1] >= top * 0.6), key=lambda g: abs(g[0] + g[1] / 2 - est))
                t = g[0] + g[1] - 0.15
            prev = max(prev, t)
            chs[i]["start"] = round(offset + max(0.0, t), 2)
        acc += len(chs[i]["text"])


def encode_mp3(pcm: bytes, rate: int) -> bytes:
    import lameenc  # 배포 때만 설치

    enc = lameenc.Encoder()
    enc.set_bit_rate(KBPS)
    enc.set_in_sample_rate(rate)
    enc.set_channels(1)
    enc.set_quality(2)
    return enc.encode(pcm) + enc.flush()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--key", action="store_true", help="캐시 키(대본 해시)만 출력")
    a = ap.parse_args()
    brief = latest_brief()
    chs = chapters(brief) if brief else []
    if a.key:
        print(script_hash(brief, chs) if chs else "none")
        return 0
    if not chs:
        log("no podcast script — skip")
        return 0
    h = script_hash(brief, chs)
    man_p = OUT / "podcast.json"
    try:
        old = json.loads(man_p.read_text(encoding="utf-8"))
        if old.get("hash") == h and (OUT / old["src"].split("/")[-1]).exists():
            log(f"up to date ({h})")
            return 0
    except Exception:  # noqa: BLE001
        pass
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        log("GEMINI_API_KEY missing — skip (browser voice is used)")
        return 0

    with httpx.Client(timeout=httpx.Timeout(300, connect=20), headers={"User-Agent": "daily-brief-podcast/1"}) as client:
        models = pick_models(client, key)
        log(f"models: {', '.join(models[:4])}")
        pcm_all = bytearray()
        rate = 0
        used = ""
        for n, idx in enumerate(groups(chs)):
            text = "\n\n".join(chs[i]["text"] for i in idx)
            try:
                pcm, r, used = synth(client, key, models, text)
            except Exception as e:  # noqa: BLE001
                log(f"tts failed: {e} — skip (browser voice is used)")
                return 0
            if rate and r != rate:
                log("sample rate changed between parts — skip")
                return 0
            rate = r
            samples = array("h")
            samples.frombytes(pcm[: len(pcm) - len(pcm) % 2])
            if sys.byteorder != "little":
                samples.byteswap()
            offset = len(pcm_all) / 2 / rate
            place_chapters(chs, idx, offset, len(samples) / rate, silences(samples, rate))
            pcm_all += pcm[: len(pcm) - len(pcm) % 2]
            pcm_all += bytes(int(rate * 0.6) * 2)  # 묶음 사이 0.6초 쉼
            if n:
                time.sleep(1)

    mp3 = encode_mp3(bytes(pcm_all), rate)
    OUT.mkdir(parents=True, exist_ok=True)
    for f in OUT.glob("podcast-*.mp3"):
        f.unlink()
    name = f"podcast-{brief['date']}-{h[:8]}.mp3"
    (OUT / name).write_bytes(mp3)
    man = {
        "date": brief["date"], "hash": h, "src": f"audio/{name}", "duration": round(len(pcm_all) / 2 / rate, 1),
        "bytes": len(mp3), "model": used, "voice": VOICE, "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "chapters": [{"title": c["title"], "start": c.get("start", 0)} for c in chs],
    }
    man_p.write_text(json.dumps(man, ensure_ascii=False, indent=1), encoding="utf-8")
    log(f"wrote {name} ({len(mp3) // 1024} KB, {man['duration']}s, {used})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
