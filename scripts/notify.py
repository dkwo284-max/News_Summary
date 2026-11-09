"""알림(선택): Telegram Bot / Gmail SMTP. 비밀값은 환경변수(GitHub Secrets)에서만 읽는다."""
from __future__ import annotations

import os
import smtplib
from email.message import EmailMessage

import httpx

from common import log


def compose(brief: dict, cfg: dict) -> str:
    """알림 본문. 구성은 config.yaml 의 notify.content 로 고른다(기본값은 이전과 같은 전체 구성).
    sections: 알림에 넣을 섹션 키 목록(없으면 전체, 한국 정치 제외) / immigration_alerts / high_impact(영향 큰 기사 제목) / status_note(품질 저하 안내) / weather_fx"""
    c = (cfg.get("notify") or {}).get("content") or {}
    want = c.get("sections")
    lines = [f"☀️ Daily Brief {brief['date']}"]
    meta = brief.get("meta") or {}
    if c.get("status_note", True) and meta.get("degraded"):
        lines.append("⚠️ AI 요약이 일부 실패해 원문 중심으로 나갔어요 (자동 재시도 예정)")
    alerts = meta.get("alerts") or []
    if alerts and c.get("immigration_alerts", True):
        lines.append("🚨 이민 알림")
        lines.extend(f"  - {a['text']}" for a in alerts[:5])
    if c.get("high_impact", False):
        high = [it for sec in brief["sections"].values() for it in sec["items"] if (it.get("impact") or {}).get("level") == "high"][:3]
        if high:
            lines.append("🎯 내게 영향 큰 소식")
            lines.extend(f"  - {it['title_ko']}" for it in high)
    for key, sec in brief["sections"].items():
        if key == "kr_politics" and not want:  # 정치는 앱에서 켠 사람만 보도록 알림에서도 제외
            continue
        if want and key not in want:
            continue
        if sec["items"]:
            country = ("한국 " if key.startswith("kr_") else "오클랜드 " if key.startswith("akl_")
                       else "" if key in ("nz_auckland", "nz_immigration") else "뉴질랜드 ")
            lines.append(f"• {country}{sec['label']}: {sec['briefing']}")
    ex = brief.get("extras") or {}
    if c.get("weather_fx", True):
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


def notify_text(subject: str, text: str, cfg: dict) -> None:
    """브리핑이 아닌 일반 알림(예: 레저 요금 변경). config 의 notify 설정(텔레그램·이메일)을 따른다."""
    n = cfg.get("notify", {})
    for name, enabled, fn in (
        ("telegram", n.get("telegram", {}).get("enabled"), lambda: send_telegram(text)),
        ("email", n.get("email", {}).get("enabled"), lambda: send_email(subject, text)),
    ):
        if not enabled:
            continue
        try:
            fn()
        except Exception as e:  # noqa: BLE001
            log.error("%s notify failed: %s", name, e)
