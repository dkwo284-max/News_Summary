"""알림(선택): Telegram Bot / Gmail SMTP. 비밀값은 환경변수(GitHub Secrets)에서만 읽는다."""
from __future__ import annotations

import os
import smtplib
from email.message import EmailMessage

import httpx

from common import log


def compose(brief: dict, cfg: dict) -> str:
    lines = [f"☀️ Daily Brief {brief['date']}"]
    alerts = (brief.get("meta") or {}).get("alerts") or []
    if alerts:
        lines.append("🚨 이민 알림")
        lines.extend(f"  - {a['text']}" for a in alerts[:5])
    for key, sec in brief["sections"].items():
        if key == "kr_politics":  # 정치는 앱에서 켠 사람만 보도록 알림에서도 제외
            continue
        if sec["items"]:
            country = "한국 " if key.startswith("kr_") else "" if key in ("nz_auckland", "nz_immigration") else "뉴질랜드 "
            lines.append(f"• {country}{sec['label']}: {sec['briefing']}")
    ex = brief.get("extras") or {}
    if ex.get("nzd_krw"):
        lines.append(f"💱 1 NZD = {ex['nzd_krw']:,}원")
    w = ex.get("auckland_weather")
    if w:
        lines.append(f"🌤 오클랜드 {w['min']}~{w['max']}°C {w['desc']}")
    lines.append(cfg["output"]["app_url"])
    return "\n".join(lines)


def send_telegram(text: str) -> None:
    token, chat = os.environ.get("TELEGRAM_BOT_TOKEN"), os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        log.warning("telegram enabled but TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set")
        return
    r = httpx.post(f"https://api.telegram.org/bot{token}/sendMessage",
                   data={"chat_id": chat, "text": text, "disable_web_page_preview": "true"}, timeout=20)
    if r.status_code >= 400:  # raise_for_status() 메시지에는 토큰이 든 URL이 찍히므로 직접 처리
        raise RuntimeError(f"telegram HTTP {r.status_code}: {r.text[:200]}")
    log.info("telegram sent")


def send_email(subject: str, text: str) -> None:
    user, pw, to = (os.environ.get(k) for k in ("SMTP_USER", "SMTP_PASSWORD", "EMAIL_TO"))
    if not (user and pw and to):
        log.warning("email enabled but SMTP_USER/SMTP_PASSWORD/EMAIL_TO not set")
        return
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, user, to
    msg.set_content(text)
    with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as s:
        s.login(user, pw)
        s.send_message(msg)
    log.info("email sent")


def notify(brief: dict, cfg: dict) -> None:
    n = cfg.get("notify", {})
    text = compose(brief, cfg)
    for name, enabled, fn in (
        ("telegram", n.get("telegram", {}).get("enabled"), lambda: send_telegram(text)),
        ("email", n.get("email", {}).get("enabled"), lambda: send_email(f"Daily Brief {brief['date']}", text)),
    ):
        if not enabled:
            continue
        try:
            fn()
        except Exception as e:  # noqa: BLE001 — 알림 실패로 브리핑 생성이 실패 처리되지 않게
            log.error("%s notify failed: %s", name, e)
