"""
Trip Swarm — app.py

FastAPI application with Google OAuth, thread management,
travel planning, agentic RAG, document management, and report storage.

Travel agent  → stateless: each request is a fresh plan, no history passed.
RAG agent     → conversational: full chat history passed for context.
"""

import os
import io
import re
import uuid
from datetime import datetime, timezone, timedelta, date as _date
import time
from typing import Optional, List

import uvicorn
import socketio
from fastapi import FastAPI, Request, Depends, HTTPException, UploadFile, File
from fastapi.responses import HTMLResponse, RedirectResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from authlib.integrations.starlette_client import OAuth
from starlette.middleware.sessions import SessionMiddleware
from sqlalchemy.orm import Session
from dotenv import load_dotenv

import requests
import random
import string

import cloudinary
import cloudinary.uploader
import cloudinary.api
import cloudinary.utils

load_dotenv()

from database import get_db, engine
from models import Base, User, ChatThread, ChatMessage, TripReport, UserDocument, TripSummary, TripSource, RagRetrievedChunk
from backend import run_travel_workflow, set_socketio, register_sid, unregister_sid
from rag_backend import run_rag_workflow, add_document_to_pinecone, delete_document, set_rag_socketio
from tools.flight_tool import extract_trip_request

cloudinary.config(
    cloud_name=os.getenv("CLOUDINARY_CLOUD_NAME"),
    api_key=os.getenv("CLOUDINARY_API_KEY"),
    api_secret=os.getenv("CLOUDINARY_API_SECRET"),
    secure=True,
)

ALLOWED_EXTENSIONS = {".pdf", ".docx", ".doc", ".txt", ".md"}


def _upload_to_cloudinary(content: bytes, filename: str,user_id: uuid.UUID, content_type: str = "application/octet-stream") -> dict:
    """
    Upload file to Cloudinary as a raw authenticated resource.
    Returns {public_id, url} where url is always empty string —
    files are served via the backend proxy endpoint, never directly.
    """
    import uuid as _uuid
    ext = os.path.splitext(filename)[1].lower()
    unique_name = f"tripswarm/users/{user_id}/docs/{_uuid.uuid4().hex}{ext}"

    result = cloudinary.uploader.upload(
        content,
        public_id=unique_name,
        resource_type="raw",
        type="authenticated",
        overwrite=False,
        use_filename=False,
    )

    public_id = result["public_id"]
    return {"public_id": public_id, "url": ""}


def _delete_from_cloudinary(public_id: str) -> None:
    """Delete a raw authenticated file from Cloudinary by public_id."""
    try:
        cloudinary.uploader.destroy(public_id, resource_type="raw", type="authenticated")
    except Exception as e:
        print(f"[Cloudinary delete] {e}")


def _get_cloudinary_download_url(public_id: str) -> str:
    """
    Generate a short-lived signed download URL for a Cloudinary
    authenticated raw asset.

    The URL is used only by the backend to fetch the file.
    It is never exposed directly to the browser.
    """
    import cloudinary.utils

    try:
        if not public_id:
            return ""

        cloud_name = os.getenv("CLOUDINARY_CLOUD_NAME")
        api_key = os.getenv("CLOUDINARY_API_KEY")
        api_secret = os.getenv("CLOUDINARY_API_SECRET")

        if not all([cloud_name, api_key, api_secret]):
            print("[Cloudinary download URL] Missing Cloudinary credentials")
            return ""

        # Valid for 5 minutes.
        expires_at = int(time.time()) + 300

        # Cloudinary SDK generates the correct signed download URL.
        signed_url = cloudinary.utils.private_download_url(
            public_id=public_id,
            format="",
            resource_type="raw",
            type="authenticated",
            expires_at=expires_at,
            attachment=False,
        )

        return signed_url

    except Exception as e:
        print(f"[Cloudinary download URL] {e}")
        return ""



Base.metadata.create_all(bind=engine)


# Socket.IO setup

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins="*",
    logger=False,
    engineio_logger=False,
)
set_socketio(sio)
set_rag_socketio(sio)

fastapi_app = FastAPI(title="Trip Swarm API", version="2.0.0")

fastapi_app.add_middleware(
    SessionMiddleware,
    secret_key=os.getenv("SECRET_KEY"),
    max_age=86400 * 30,
    same_site="lax",
    https_only=os.getenv("HTTPS_ONLY", "false").lower() == "true",
)

fastapi_app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# Wrap with Socket.IO ASGI app
app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)

oauth = OAuth()
oauth.register(
    name="google",
    client_id=os.getenv("GOOGLE_CLIENT_ID"),
    client_secret=os.getenv("GOOGLE_CLIENT_SECRET"),
    server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
    client_kwargs={"scope": "openid email profile", "prompt": "select_account"},
)

IST = timezone(timedelta(hours=5, minutes=30))

OTP_EXPIRY_SECONDS = 600   # 10 minutes
OTP_MAX_TRIES      = 5
SESSION_OTP_DAYS   = 7
SESSION_GOOGLE_DAYS = 30

MAILER_SERVICE_URL = os.getenv("MAILER_SERVICE_URL", "")   # your Vercel URL
MAILER_API_SECRET  = os.getenv("MAILER_API_SECRET", "")


def now_ist() -> datetime:
    return datetime.now(tz=IST)


def fmt_utc(dt: datetime) -> str:
    if dt is None:
        return ""
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"



# Socket.IO events

@sio.event
async def connect(sid, environ):
    pass  # clients connect silently


@sio.event
async def disconnect(sid):
    pass


@sio.event
async def join_trip(sid, data):
    """Client sends {thread_id} to associate this socket with a planning request."""
    thread_id = str(data.get("thread_id", sid))
    register_sid(thread_id, sid)
    await sio.emit("joined", {"thread_id": thread_id}, to=sid)


@sio.event
async def leave_trip(sid, data):
    thread_id = str(data.get("thread_id", ""))
    unregister_sid(thread_id)


# Auth Helpers

def get_current_user(request: Request, db: Session = Depends(get_db)) -> Optional[User]:
    user_id = request.session.get("user_id")
    if not user_id:
        return None

    # Enforce per-login-method expiry (OTP = 7 days, Google = 30 days).
    # Sessions created before this change have no expires_at and are logged out once.
    expires_at = request.session.get("expires_at")
    if not expires_at or time.time() > expires_at:
        request.session.clear()
        return None

    return db.query(User).filter(User.id == user_id).first()


def require_user(request: Request, db: Session = Depends(get_db)) -> User:
    user = get_current_user(request, db)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


# PDF Export (ReportLab)

_EMOJI_RE = re.compile(
    "[\U0001F300-\U0001FFFF"
    "\U00002600-\U000027BF"
    "\U0000FE00-\U0000FE0F"
    "\U00002702-\U000027B0"
    "\U000024C2-\U0001F251"
    "]+",
    flags=re.UNICODE,
)


def _strip_emoji(text: str) -> str:
    return _EMOJI_RE.sub("", text).strip()


def _markdown_to_pdf_bytes(markdown_text: str) -> bytes:
    from reportlab.lib.pagesizes import A4
    from reportlab.lib import colors
    from reportlab.lib.units import cm
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.enums import TA_CENTER, TA_LEFT
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, HRFlowable,
        Table, TableStyle, Image, ListFlowable, ListItem, KeepTogether,
    )
    from reportlab.lib.colors import HexColor
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from pathlib import Path

    try:
        pdfmetrics.registerFont(TTFont("DejaVu",      "static/fonts/DejaVuSans.ttf"))
        pdfmetrics.registerFont(TTFont("DejaVu-Bold", "static/fonts/DejaVuSans-Bold.ttf"))
        FONT_NORMAL = "DejaVu"
        FONT_BOLD   = "DejaVu-Bold"
    except Exception:
        FONT_NORMAL = "Helvetica"
        FONT_BOLD   = "Helvetica-Bold"

    # ── Color palette ──────────────────────────────────────────────────────────
    ACCENT      = HexColor("#38bdf8")   # sky blue
    ACCENT_DIM  = HexColor("#e0f7ff")
    DARK        = HexColor("#1e293b")
    SLATE       = HexColor("#64748b")
    WHITE       = colors.white
    LIGHT_ROW   = HexColor("#f8fafc")
    BORDER      = HexColor("#cbd5e1")
    SECTION_BG  = HexColor("#f0f9ff")   # faint blue for section headers
    PRICE_GREEN = HexColor("#16a34a")
    WARN_AMBER  = HexColor("#d97706")

    page_w, page_h = A4
    margin   = 1.8 * cm
    content_w = page_w - 2 * margin
    buf = io.BytesIO()

    # Header / footer on every page 
    def _header_footer(canvas, doc):
        canvas.saveState()
        # top rule
        canvas.setStrokeColor(ACCENT)
        canvas.setLineWidth(2.5)
        canvas.line(margin, page_h - margin + 8, page_w - margin, page_h - margin + 8)
        # footer text
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(SLATE)
        canvas.drawCentredString(page_w / 2, margin / 2,
                                 f"TripSwarm  ·  Page {doc.page}  ·  AI-generated travel plan")
        # footer rule
        canvas.setStrokeColor(BORDER)
        canvas.setLineWidth(0.4)
        canvas.line(margin, margin - 5, page_w - margin, margin - 5)
        canvas.restoreState()

    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        leftMargin=margin, rightMargin=margin,
        topMargin=margin + 0.6 * cm, bottomMargin=margin + 0.4 * cm,
        onFirstPage=_header_footer, onLaterPages=_header_footer,
    )

    #  Paragraph styles
    def S(name, **kw):
        return ParagraphStyle(name, **kw)

    styles = {
        "title":   S("Title",   fontName=FONT_BOLD,   fontSize=22, textColor=ACCENT,  alignment=TA_CENTER, spaceAfter=4,  leading=28),
        "meta":    S("Meta",    fontName=FONT_NORMAL,  fontSize=8.5,textColor=SLATE,  alignment=TA_CENTER, spaceAfter=14, leading=12),
        "h1":      S("H1",      fontName=FONT_BOLD,   fontSize=14, textColor=WHITE,   spaceBefore=14, spaceAfter=6,  leading=18),
        "h2":      S("H2",      fontName=FONT_BOLD,   fontSize=11.5,textColor=DARK,   spaceBefore=10, spaceAfter=4,  leading=15),
        "h3":      S("H3",      fontName=FONT_BOLD,   fontSize=10, textColor=SLATE,   spaceBefore=8,  spaceAfter=3,  leading=13),
        "body":    S("Body",    fontName=FONT_NORMAL,  fontSize=9.5,textColor=DARK,   spaceAfter=4,  leading=14),
        "bullet":  S("Bullet",  fontName=FONT_NORMAL,  fontSize=9.5,textColor=DARK,   leftIndent=16, spaceAfter=3, leading=13,
                     bulletIndent=4, bulletFontName=FONT_NORMAL),
        "subbullet":S("Sub",    fontName=FONT_NORMAL,  fontSize=9,  textColor=SLATE,  leftIndent=30, spaceAfter=2, leading=12,
                     bulletIndent=18, bulletFontName=FONT_NORMAL),
        "numbered":S("Num",     fontName=FONT_NORMAL,  fontSize=9.5,textColor=DARK,   leftIndent=16, spaceAfter=5, leading=14,
                     bulletIndent=4, bulletFontName=FONT_BOLD),
        "flight":  S("Flight",  fontName=FONT_BOLD,   fontSize=9.5,textColor=DARK,   spaceAfter=2,  leading=13),
        "flightd": S("FlightD", fontName=FONT_NORMAL,  fontSize=8.5,textColor=SLATE,  leftIndent=12, spaceAfter=1.5, leading=12),
        "price":   S("Price",   fontName=FONT_BOLD,   fontSize=10, textColor=PRICE_GREEN, spaceAfter=2, leading=14),
        "day":     S("Day",     fontName=FONT_BOLD,   fontSize=10.5,textColor=ACCENT,  spaceBefore=10, spaceAfter=3, leading=14),
        "budget":  S("Budget",  fontName=FONT_NORMAL,  fontSize=9.5,textColor=DARK,   leftIndent=12, spaceAfter=3, leading=14),
        "total":   S("Total",   fontName=FONT_BOLD,   fontSize=11, textColor=DARK,    spaceBefore=6, spaceAfter=4, leading=15),
        "tip":     S("Tip",     fontName=FONT_NORMAL,  fontSize=9.5,textColor=DARK,   leftIndent=16, spaceAfter=3, leading=13,
                     bulletIndent=4, bulletFontName=FONT_BOLD),
        "warn":    S("Warn",    fontName=FONT_NORMAL,  fontSize=9,  textColor=WARN_AMBER, spaceAfter=4, leading=13),
        "code":    S("Code",    fontName="Courier",    fontSize=8,  textColor=DARK,    backColor=LIGHT_ROW, leftIndent=10,
                     rightIndent=10, spaceAfter=6, leading=11),
    }

    # Inline markdown → ReportLab XML
    def _inline(text: str) -> str:
        text = _strip_emoji(text)
        text = re.sub(r"\\([*_`\\])", r"\1", text)
        text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        text = re.sub(r"\*\*\*(.+?)\*\*\*", r"<b><i>\1</i></b>", text)
        text = re.sub(r"\*\*(.+?)\*\*",     r"<b>\1</b>",        text)
        text = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<i>\1</i>", text)
        text = re.sub(r"`(.+?)`", r'<font name="Courier" size="8.5" color="#0369a1">\1</font>', text)
        return text

    #  Section header block (coloured band) 
    def _section_header(text: str) -> list:
        """Render ## heading as a coloured band."""
        tbl = Table(
            [[Paragraph(_inline(text), styles["h1"])]],
            colWidths=[content_w],
        )
        tbl.setStyle(TableStyle([
            ("BACKGROUND",  (0, 0), (-1, -1), ACCENT),
            ("ROWPADDING",  (0, 0), (-1, -1), (10, 6, 10, 6)),
            ("ROUNDEDCORNERS", [6]),
            ("BOX",         (0, 0), (-1, -1), 0, ACCENT),
        ]))
        return [Spacer(1, 6), tbl, Spacer(1, 6)]

    def _add_rule(story):
        story.append(Spacer(1, 4))
        story.append(HRFlowable(width="100%", thickness=0.4, color=BORDER))
        story.append(Spacer(1, 4))

    # Flight block renderer
    def _render_flight_block(lines_block: list[str]) -> list:
        """
        Render a numbered flight option block.
        Detects lines like:
          1. Price: INR 21,320 | Non-stop | Total: 1h 30m
             Leg 1: 6E 588 | IndiGo | Airbus A320
               DEP: MAA Chennai Intl @ 17:40
               ARR: GOI Dabolim Intl @ 19:10
               Duration: 1h 30m | Class: Economy
        """
        elements = []
        for line in lines_block:
            stripped = line.strip()
            if not stripped:
                continue
            # Numbered flight option header
            if re.match(r"^\d+\.", stripped):
                # Extract price if present
                price_match = re.search(r"Price[:\s]+([A-Z]+\s[\d,]+)", stripped)
                rest        = re.sub(r"^\d+\.\s*", "", stripped)
                if price_match:
                    price_str = price_match.group(1)
                    rest_no_price = re.sub(r"Price[:\s]+[A-Z]+\s[\d,]+\s*\|?\s*", "", rest).strip().strip("|").strip()
                    elements.append(Paragraph(f"<b>{_inline(rest_no_price)}</b>", styles["flight"]))
                    elements.append(Paragraph(f"<b>{_inline('Price: ' + price_str)}</b>", styles["price"]))
                else:
                    elements.append(Paragraph(f"<b>{_inline(rest)}</b>", styles["flight"]))
            # Leg / sub-detail lines
            elif stripped.startswith("Leg ") or stripped.startswith("DEP:") or \
                 stripped.startswith("ARR:") or stripped.startswith("Duration") or \
                 stripped.startswith("Layover") or stripped.startswith("Class"):
                elements.append(Paragraph(_inline(stripped), styles["flightd"]))
            else:
                elements.append(Paragraph(_inline(stripped), styles["body"]))
        return elements

    # Strip fenced code blocks 
    cleaned_lines: list[str] = []
    in_code = False
    for raw in markdown_text.splitlines():
        if raw.strip().startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        cleaned_lines.append(raw)

    lines = cleaned_lines
    n     = len(lines)
    story = []

    # Logo 
    logo_path = Path("static/images/Trip_Swarm_Logo.png")
    if logo_path.exists():
        logo = Image(str(logo_path))
        logo.drawHeight = 2.8 * cm
        logo.drawWidth  = 2.8 * cm
        logo.hAlign     = "CENTER"
        story.append(logo)
        story.append(Spacer(1, 0.2 * cm))

    # Title block
    doc_title = "TripSwarm Report"
    # for ln in lines:
    #     if ln.startswith("## "):
    #         doc_title = _strip_emoji(ln[2:].strip())
    #         break
    #     elif ln.strip():
    #         doc_title = _strip_emoji(ln.strip())
    #         break

    story.append(Paragraph(_inline(doc_title), styles["title"]))
    story.append(Paragraph(
        f"Generated by TripSwarm  ·  {datetime.now().strftime('%d %b %Y, %I:%M %p')}",
        styles["meta"]
    ))
    _add_rule(story)

    # Main parse loop 
    i                  = 0
    first_h1_skipped   = False
    in_flight_section  = False
    flight_lines_buf: list[str] = []

    def _flush_flight_buf(story, buf):
        if buf:
            block_elements = _render_flight_block(buf)
            # Wrap each flight option in a light box
            if block_elements:
                box = Table(
                    [[e] for e in block_elements],
                    colWidths=[content_w - 16],
                )
                box.setStyle(TableStyle([
                    ("BACKGROUND",   (0, 0), (-1, -1), LIGHT_ROW),
                    ("BOX",          (0, 0), (-1, -1), 0.5, BORDER),
                    ("ROWPADDING",   (0, 0), (-1, -1), (8, 3, 8, 3)),
                ]))
                story.append(box)
                story.append(Spacer(1, 6))
        return []

    while i < n:
        line    = lines[i]
        stripped = line.strip()

        if not stripped:
            if in_flight_section:
                flight_lines_buf.append("")
            i += 1
            continue

        # H1 — document title (skip first occurrence)
        if line.startswith("# "):
            if not first_h1_skipped:
                first_h1_skipped = True
                i += 1
                continue
            flight_lines_buf = _flush_flight_buf(story, flight_lines_buf)
            in_flight_section = False
            story.append(Paragraph(_inline(line[2:].strip()), styles["h1"]))
            i += 1
            continue

        # H2 — section headers (coloured band)
        if line.startswith("## "):
            flight_lines_buf = _flush_flight_buf(story, flight_lines_buf)
            heading_text = line[3:].strip()
            story.extend(_section_header(heading_text))
            # Check if this is the flights section
            in_flight_section = any(kw in heading_text.lower()
                                    for kw in ["flight", "✈️"])
            i += 1
            continue

        # H3 — day headings / sub-section
        if line.startswith("### "):
            flight_lines_buf = _flush_flight_buf(story, flight_lines_buf)
            in_flight_section = False
            day_text = line[4:].strip()
            story.append(Paragraph(_inline(day_text), styles["day"]))
            i += 1
            continue

        # Horizontal rule
        if re.match(r"^[-*_]{3,}\s*$", line):
            _add_rule(story)
            i += 1
            continue

        # Flight section — buffer lines for special rendering
        if in_flight_section:
            flight_lines_buf.append(line)
            i += 1
            continue

        # Markdown table
        if stripped.startswith("|"):
            tbl_lines = []
            while i < n and lines[i].strip().startswith("|"):
                tbl_lines.append(lines[i])
                i += 1
            rows = []
            for raw in tbl_lines:
                s = raw.strip().strip("|")
                if re.match(r"^[\s\-:|]+$", s):
                    continue
                cells = [c.strip() for c in s.split("|")]
                if cells:
                    rows.append(cells)
            if len(rows) >= 2:
                col_count = len(rows[0])
                tdata = [[Paragraph(f"<b>{_inline(h)}</b>", styles["body"]) for h in rows[0]]]
                for dr in rows[1:]:
                    while len(dr) < col_count: dr.append("")
                    tdata.append([Paragraph(_inline(c), styles["body"]) for c in dr[:col_count]])
                tbl = Table(tdata, colWidths=[content_w / col_count] * col_count, repeatRows=1)
                tbl.setStyle(TableStyle([
                    ("BACKGROUND",     (0, 0), (-1, 0),  ACCENT_DIM),
                    ("FONTNAME",       (0, 0), (-1, 0),  FONT_BOLD),
                    ("FONTSIZE",       (0, 0), (-1, 0),  9),
                    ("FONTNAME",       (0, 1), (-1, -1), FONT_NORMAL),
                    ("FONTSIZE",       (0, 1), (-1, -1), 9),
                    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, LIGHT_ROW]),
                    ("GRID",           (0, 0), (-1, -1), 0.4, BORDER),
                    ("VALIGN",         (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING",    (0, 0), (-1, -1), 6),
                    ("RIGHTPADDING",   (0, 0), (-1, -1), 6),
                    ("TOPPADDING",     (0, 0), (-1, -1), 4),
                    ("BOTTOMPADDING",  (0, 0), (-1, -1), 4),
                ]))
                story.append(Spacer(1, 6))
                story.append(tbl)
                story.append(Spacer(1, 8))
            continue

        # Unordered list
        if re.match(r"^[\-\*\+] ", line):
            items = []
            while i < n and re.match(r"^[\-\*\+] ", lines[i]):
                item_text = lines[i][2:].strip()
                # Detect sub-items indicated by extra indent (we handle flat lists)
                # Check if it's a budget total line
                if "total" in item_text.lower() and any(c.isdigit() for c in item_text):
                    items.append(ListItem(
                        Paragraph(f"<b>{_inline(item_text)}</b>", styles["total"]),
                        bulletColor=ACCENT
                    ))
                else:
                    items.append(ListItem(
                        Paragraph(_inline(item_text), styles["bullet"]),
                        bulletColor=ACCENT
                    ))
                i += 1
            story.append(ListFlowable(items, bulletType="bullet",
                                      leftIndent=18, bulletFontSize=9.5, bulletOffsetY=-1))
            story.append(Spacer(1, 4))
            continue

        # Ordered list
        if re.match(r"^\d+\. ", line):
            items = []
            while i < n and re.match(r"^\d+\. ", lines[i]):
                num  = re.match(r"^(\d+)\.", lines[i]).group(1)
                text = re.sub(r"^\d+\.\s*", "", lines[i]).strip()
                items.append(ListItem(
                    Paragraph(_inline(text), styles["numbered"]),
                    bulletColor=ACCENT,
                    value=int(num),
                ))
                i += 1
            story.append(ListFlowable(items, bulletType="1",
                                      leftIndent=18, bulletFontSize=9.5))
            story.append(Spacer(1, 4))
            continue

        # Blockquote
        if line.startswith("> "):
            bq_lines = []
            while i < n and lines[i].startswith("> "):
                bq_lines.append(lines[i][2:])
                i += 1
            bq_style = S("BQ", fontName="Helvetica-Oblique", fontSize=9, textColor=SLATE,
                          leftIndent=20, spaceAfter=6, borderPad=4, leading=13)
            story.append(Paragraph(f"<i>{_inline(' '.join(bq_lines))}</i>", bq_style))
            continue

        # Plain paragraph
        story.append(Paragraph(_inline(stripped), styles["body"]))
        i += 1

    # Flush any remaining flight lines
    _flush_flight_buf(story, flight_lines_buf)

    doc.build(story)
    buf.seek(0)
    return buf.read()


# OTP + Mailer Helpers

def _generate_otp(length: int = 6) -> str:
    return "".join(random.choices(string.digits, k=length))


def _send_otp_email(to_email: str, otp: str):
    if not MAILER_SERVICE_URL:
        raise Exception("MAILER_SERVICE_URL not configured")
    expiry_mins = OTP_EXPIRY_SECONDS // 60
    response = requests.post(
        f"{MAILER_SERVICE_URL}/send-otp",
        headers={"X-API-Secret": MAILER_API_SECRET, "Content-Type": "application/json"},
        json={"to_email": to_email, "otp": otp, "expiry_mins": expiry_mins},
        timeout=30,
    )
    if response.status_code != 200:
        raise Exception(f"Mailer error {response.status_code}: {response.text}")


def _send_welcome_email(to_email: str, name: str):
    """Send a one-time welcome mail via the Vercel mailer service."""
    if not MAILER_SERVICE_URL:
        return
    try:
        requests.post(
            f"{MAILER_SERVICE_URL}/send-welcome",
            headers={"X-API-Secret": MAILER_API_SECRET, "Content-Type": "application/json"},
            json={"to_email": to_email, "name": name},
            timeout=30,
        )
    except Exception as e:
        print(f"[Welcome Mail] failed: {e}")


def _upsert_user_otp(
    db: Session, email: str, name: str | None = None
) -> tuple["User", bool]:
    """
    Find or create a user by email for OTP login.
    Returns (user, is_new_user).
    """
    from models import User as UserModel
    user = db.query(UserModel).filter(UserModel.email == email).first()
    is_new = False
    if user:
        # Merge auth_provider
        providers = set((user.auth_provider or "").split(","))
        providers.add("otp")
        user.auth_provider = ",".join(sorted(providers))
        user.last_login    = datetime.utcnow()
        db.commit()
        db.refresh(user)
    else:
        user = UserModel(
            email=email,
            name=name or email.split("@")[0],
            picture="",
            auth_provider="otp",
            is_verified=1,
            last_login=datetime.utcnow(),
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        is_new = True
    return user, is_new


def _set_session(request: Request, user: "User", session_days: int):
    request.session["user_id"]      =  str(user.id)
    request.session["session_days"] = session_days
    request.session["expires_at"]   = int(time.time() + session_days * 86400)



# OTP Routes

from models import OtpToken


@fastapi_app.post("/api/otp/send")
async def otp_send(request: Request, db: Session = Depends(get_db)):
    body  = await request.json()
    email = (body.get("email") or "").strip().lower()
    name  = (body.get("name") or "").strip()

    if not email.endswith("@gmail.com"):
        raise HTTPException(status_code=400, detail="Only @gmail.com addresses are accepted.")

    existing_user = db.query(User).filter(User.email == email).first()
    is_new_user   = existing_user is None

    if is_new_user and not name:
        # Front-end should have asked for name; treat as missing
        raise HTTPException(status_code=422, detail="name_required")

    otp     = _generate_otp()
    expires = datetime.utcnow() + timedelta(seconds=OTP_EXPIRY_SECONDS)

    record = db.query(OtpToken).filter(OtpToken.email == email).first()
    if record:
        record.code       = otp
        record.expires_at = expires
        record.tries      = 0
        record.name       = name if is_new_user else (existing_user.name if existing_user else name)
    else:
        record = OtpToken(
            email=email,
            code=otp,
            expires_at=expires,
            tries=0,
            name=name if is_new_user else (existing_user.name if existing_user else name),
        )
        db.add(record)
    db.commit()

    try:
        _send_otp_email(email, otp)
    except Exception as e:
        db.delete(record)
        db.commit()
        print(f"[OTP Send] {e}")
        raise HTTPException(status_code=500, detail="Failed to send OTP. Please try again.")

    return JSONResponse({"ok": True, "is_new_user": is_new_user})


@fastapi_app.post("/api/otp/verify")
async def otp_verify(request: Request, db: Session = Depends(get_db)):
    body    = await request.json()
    email   = (body.get("email") or "").strip().lower()
    entered = (body.get("otp") or "").strip()

    if not email or not entered:
        raise HTTPException(status_code=400, detail="Email and OTP are required.")

    record = db.query(OtpToken).filter(OtpToken.email == email).first()
    if not record:
        raise HTTPException(status_code=400, detail="No pending code for this email. Request a new one.")

    if datetime.utcnow() > record.expires_at:
        db.delete(record)
        db.commit()
        raise HTTPException(status_code=400, detail="Your code has expired. Please request a new one.")

    if record.tries >= OTP_MAX_TRIES:
        db.delete(record)
        db.commit()
        raise HTTPException(status_code=400, detail="Too many incorrect attempts. Please request a new code.")

    if entered != record.code:
        record.tries += 1
        db.commit()
        remaining = OTP_MAX_TRIES - record.tries
        raise HTTPException(
            status_code=400,
            detail=f"Incorrect code. {remaining} attempt(s) remaining.",
        )

    # Correct — clean up token
    saved_name = record.name or ""
    db.delete(record)
    db.commit()

    user, is_new = _upsert_user_otp(db, email=email, name=saved_name)
    _set_session(request, user, SESSION_OTP_DAYS)

    # Send welcome mail only for brand-new users
    if is_new:
        _send_welcome_email(user.email, user.name)

    return JSONResponse({
        "ok":       True,
        "is_new":   is_new,
        "user": {
            "id":      str(user.id),
            "name":    user.name,
            "email":   user.email,
            "picture": user.picture or "",
        },
    })


@fastapi_app.post("/api/otp/resend")
async def otp_resend(request: Request, db: Session = Depends(get_db)):
    body  = await request.json()
    email = (body.get("email") or "").strip().lower()

    if not email:
        raise HTTPException(status_code=400, detail="Email is required.")

    record = db.query(OtpToken).filter(OtpToken.email == email).first()
    if not record:
        raise HTTPException(status_code=400, detail="No pending request. Please start again.")

    otp     = _generate_otp()
    expires = datetime.utcnow() + timedelta(seconds=OTP_EXPIRY_SECONDS)
    record.code       = otp
    record.expires_at = expires
    record.tries      = 0
    db.commit()

    try:
        _send_otp_email(email, otp)
    except Exception as e:
        print(f"[OTP Resend] {e}")
        raise HTTPException(status_code=500, detail="Failed to resend OTP. Please try again.")

    return JSONResponse({"ok": True})



# Pages

@fastapi_app.get("/", response_class=HTMLResponse)
async def homepage(request: Request, db: Session = Depends(get_db)):
    return templates.TemplateResponse(request=request, name="index.html")


@fastapi_app.get("/chat", response_class=HTMLResponse)
async def chat_page(request: Request, db: Session = Depends(get_db)):
    user = get_current_user(request, db)
    if not user:
        next_url = str(request.url)
        return RedirectResponse(url=f"/?next={next_url}", status_code=302)
    return templates.TemplateResponse(request=request, name="chat.html", context={"user": user})


@fastapi_app.get("/terms", response_class=HTMLResponse)
async def terms_page(request: Request):
    return templates.TemplateResponse(request=request, name="terms.html")



# Session check

@fastapi_app.get("/api/me")
async def api_me(request: Request, db: Session = Depends(get_db)):
    user = get_current_user(request, db)
    if not user:
        return JSONResponse({"logged_in": False, "user": None})
    return JSONResponse({
        "logged_in": True,
        "user": {
            "id":      str(user.id),
            "name":    user.name,
            "email":   user.email,
            "picture": user.picture or "",
        },
    })


# Google OAuth

@fastapi_app.get("/auth/login")
async def auth_login(request: Request):
    redirect_uri = str(request.url_for("auth_callback"))
    return await oauth.google.authorize_redirect(request, redirect_uri, prompt="select_account")


@fastapi_app.get("/auth/callback", name="auth_callback")
async def auth_callback(request: Request, db: Session = Depends(get_db)):
    try:
        token     = await oauth.google.authorize_access_token(request)
        user_info = token.get("userinfo")
        if not user_info:
            user_info = await oauth.google.userinfo(token=token)

        google_id = user_info["sub"]
        email     = user_info["email"]
        name      = user_info.get("name", email.split("@")[0])
        picture   = user_info.get("picture", "")

        user = db.query(User).filter(User.email == email).first()
        is_new = False

        if user:
            # Merge auth_provider
            providers = set((user.auth_provider or "google").split(","))
            providers.add("google")
            user.auth_provider = ",".join(sorted(providers))
            if not user.google_id:
                user.google_id = google_id
            user.name       = name
            user.picture    = picture
            user.last_login = datetime.utcnow()
        else:
            user = User(
                google_id=google_id,
                email=email,
                name=name,
                picture=picture,
                auth_provider="google",
                is_verified=1,
                last_login=datetime.utcnow(),
            )
            db.add(user)
            is_new = True

        db.commit()
        db.refresh(user)
        _set_session(request, user, SESSION_GOOGLE_DAYS)

        # Send welcome mail only for brand-new users (never logged in before)
        if is_new:
            _send_welcome_email(user.email, user.name)

        return RedirectResponse(url="/chat", status_code=302)

    except Exception as e:
        print(f"Auth error: {e}")
        return RedirectResponse(url="/?error=auth_failed", status_code=302)


@fastapi_app.get("/auth/logout")
async def auth_logout(request: Request):
    request.session.clear()
    return RedirectResponse(url="/", status_code=302)



# Thread Management

@fastapi_app.get("/api/threads")
async def list_threads(request: Request, db: Session = Depends(get_db)):
    user = require_user(request, db)
    threads = (
        db.query(ChatThread)
        .filter(ChatThread.user_id == user.id)
        .order_by(ChatThread.updated_at.desc())
        .limit(60)
        .all()
    )
    return JSONResponse([
        {
            "id":         str(t.id),
            "title":      t.title,
            "type":       t.thread_type,
            "created_at": fmt_utc(t.created_at),
            "updated_at": fmt_utc(t.updated_at),
        }
        for t in threads
    ])


@fastapi_app.post("/api/threads")
async def create_thread(request: Request, db: Session = Depends(get_db)):
    user = require_user(request, db)
    body = await request.json()
    thread = ChatThread(
        user_id=user.id,
        thread_type=body.get("type", "travel"),
        title=body.get("title", "New Chat"),
    )
    db.add(thread); db.commit(); db.refresh(thread)
    return JSONResponse({
        "id":        str(thread.id),
        "title":      thread.title,
        "type":       thread.thread_type,
        "created_at": fmt_utc(thread.created_at),
        "updated_at": fmt_utc(thread.updated_at),
    })


@fastapi_app.delete("/api/threads/{thread_id}")
async def delete_thread(thread_id: uuid.UUID, request: Request, db: Session = Depends(get_db)):
    user   = require_user(request, db)
    thread = db.query(ChatThread).filter(ChatThread.id == thread_id, ChatThread.user_id == user.id).first()
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    db.delete(thread); db.commit()
    return JSONResponse({"ok": True})


@fastapi_app.patch("/api/threads/{thread_id}/rename")
async def rename_thread(thread_id: uuid.UUID,request: Request, db: Session = Depends(get_db)):
    user      = require_user(request, db)
    body      = await request.json()
    new_title = (body.get("title") or "").strip()
    if not new_title:
        raise HTTPException(status_code=400, detail="Title is required")
    if len(new_title) > 80:
        raise HTTPException(status_code=400, detail="Title too long (max 80 chars)")
    thread = db.query(ChatThread).filter(ChatThread.id == thread_id, ChatThread.user_id == user.id).first()
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    thread.title      = new_title
    thread.updated_at = datetime.utcnow()
    db.commit()
    return JSONResponse({"id": str(thread.id), "title": thread.title, "updated_at": fmt_utc(thread.updated_at)})


@fastapi_app.get("/api/threads/{thread_id}/messages")
async def get_thread_messages(thread_id: uuid.UUID, request: Request, db: Session = Depends(get_db)):
    user   = require_user(request, db)
    thread = db.query(ChatThread).filter(ChatThread.id == thread_id, ChatThread.user_id == user.id).first()
    if not thread:
        raise HTTPException(status_code=404, detail="Thread not found")
    messages = (
        db.query(ChatMessage)
        .filter(ChatMessage.thread_id == thread_id)
        .order_by(ChatMessage.created_at.asc())
        .all()
    )
    return JSONResponse([
        {
            "id":             str(m.id),
            "role":           m.role,
            "content":        m.content,
            "created_at":     fmt_utc(m.created_at),
            "attached_files": m.attached_files or [],
        }
        for m in messages
    ])




# Parse Trip

@fastapi_app.post("/api/parse-trip")
async def parse_trip_endpoint(request: Request, db: Session = Depends(get_db)):
    user = require_user(request, db)
    body  = await request.json()
    query = (body.get("query") or "").strip()

    if not query:
        return JSONResponse({
            "valid": False, "needs_dates": True, "needs_route": True,
            "trip_info": None, "warnings": [], "error": "Empty query.",
        })

    trip = extract_trip_request(query, user_country=user.country or "India")

    needs_route = not trip.get("origin_iata") or not trip.get("destination_iata")
    needs_dates = not trip.get("start_date") or not trip.get("end_date")

    warnings = []
    today = _date.today()

    if trip.get("start_date") and not needs_dates:
        try:
            start = datetime.strptime(trip["start_date"], "%Y-%m-%d").date()
            delta = (start - today).days
            if delta < 0:
                needs_dates = True
            elif delta < 7:
                warnings.append(
                    "⚠️ Your trip starts very soon. Trips are best planned at least 7 days in advance."
                )
            origin_iata = trip.get("origin_iata", "")
            dest_iata   = trip.get("destination_iata", "")
            if origin_iata and dest_iata and delta < 30:
                try:
                    import airportsdata
                    airports     = airportsdata.load("IATA")
                    orig_country = airports.get(origin_iata, {}).get("country", "")
                    dest_country = airports.get(dest_iata,   {}).get("country", "")
                    if orig_country and dest_country and orig_country != dest_country and delta < 30:
                        warnings.append(
                            "⚠️ For international trips, booking at least 1 month ahead is recommended."
                        )
                except Exception:
                    pass
        except (ValueError, TypeError):
            needs_dates = True

    is_valid = not needs_route and not needs_dates

    return JSONResponse({
        "valid":       is_valid,
        "needs_dates": needs_dates,
        "needs_route": needs_route,
        "trip_info":   trip if not needs_route else None,
        "warnings":    warnings,
        "error":       trip.get("error", "") if not is_valid else "",
    })




# Travel Planning — passes sid to backend

@fastapi_app.post("/api/travel")
async def travel_endpoint(request: Request, db: Session = Depends(get_db)):
    user         = require_user(request, db)
    body         = await request.json()
    message      = (body.get("message") or "").strip()
    trip_info    = body.get("trip_info") or {}
    flight_prefs = body.get("flight_prefs") or {}
    travel_prefs = body.get("travel_prefs") or {}
    thread_id_raw = body.get("thread_id")
    sid          = body.get("sid") or ""
    trip_summary_data = body.get("trip_summary_data") or {}   # ← new: summary card data from frontend

    thread_id = None
    if thread_id_raw:
        try:
            thread_id = uuid.UUID(str(thread_id_raw))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid thread_id")

    if not message:
        raise HTTPException(status_code=400, detail="Message is required")
    if not trip_info.get("origin_iata") or not trip_info.get("destination_iata"):
        raise HTTPException(status_code=400, detail="Missing route information.")
    if not trip_info.get("start_date") or not trip_info.get("end_date"):
        raise HTTPException(status_code=400, detail="Missing trip dates.")

    thread = None
    if thread_id:
        thread = db.query(ChatThread).filter(
            ChatThread.id == thread_id, ChatThread.user_id == user.id,
        ).first()
    if not thread:
        title  = message[:60] + ("..." if len(message) > 60 else "")
        thread = ChatThread(user_id=user.id, thread_type="travel", title=title)
        db.add(thread); db.commit(); db.refresh(thread)

    user_msg = ChatMessage(
        thread_id=thread.id, user_id=user.id, role="user", content=message,
    )
    db.add(user_msg)
    db.commit()
    db.refresh(user_msg)

    result = await run_travel_workflow(
        message=message,
        trip_info=trip_info,
        flight_prefs=flight_prefs,
        travel_prefs=travel_prefs,
        sid=sid,
    )

    if result.get("error"):
        error_text = result["error"]
        err_msg = ChatMessage(
            thread_id=thread.id, user_id=user.id, role="assistant", content=error_text,
        )
        db.add(err_msg)
        thread.updated_at = datetime.utcnow()
        db.commit()
        db.refresh(err_msg)
        return JSONResponse({
            "response": "", "error": error_text,
            "thread_id": str(thread.id), "thread_title": thread.title,
            "user_created_at":      fmt_utc(user_msg.created_at),
            "assistant_created_at": fmt_utc(err_msg.created_at),
        })

    response_text = result.get("response", "No response generated.")

    ai_msg = ChatMessage(
        thread_id=thread.id, user_id=user.id, role="assistant", content=response_text,
    )
    db.add(ai_msg)
    thread.updated_at = datetime.utcnow()

    existing_count = (
        db.query(ChatMessage)
        .filter(ChatMessage.thread_id == thread.id, ChatMessage.role == "user")
        .count()
    )
    if existing_count <= 1:
        thread.title = message[:60]

    # ── Flush ai_msg first so it gets its real DB id ──
    db.flush()
    assistant_chat_id = ai_msg.id   # ← now has the real id after flush

    # ── Save trip summary first so we have its id for the report ──
    summary_rec = None
    if trip_summary_data:
        summary_rec = TripSummary(
            user_id=user.id,
            thread_id=thread.id,
            assistant_chat_id=assistant_chat_id,
            trip_info=trip_info,
            flight_prefs=flight_prefs,
            travel_prefs=travel_prefs,
        )
        db.add(summary_rec)
        db.flush()   # get summary_rec.id before creating report

    report = TripReport(
        user_id=user.id,
        thread_id=thread.id,
        assistant_chat_id=assistant_chat_id,
        trip_summary_id=summary_rec.id if summary_rec else None,
        title=f"Trip Plan: {message}",
        content=response_text,
    )
    db.add(report)

    # ── Save trip sources (flight results text + destination URLs) ──
    flight_results_text = result.get("flight_results_text") or ""
    destination_sources = result.get("destination_sources") or {}

    source_rec = TripSource(
        user_id=user.id,
        thread_id=thread.id,
        assistant_chat_id=assistant_chat_id,
        flight_results_text=flight_results_text if flight_results_text else None,
        destination_urls=destination_sources if destination_sources else {},
    )
    db.add(source_rec)

    db.commit()
    db.refresh(ai_msg)

    # ── Load saved source id ──
    saved_source = db.query(TripSource).filter(
        TripSource.thread_id == thread.id,
        TripSource.user_id == user.id,
    ).order_by(TripSource.created_at.desc()).first()

    saved_summary = db.query(TripSummary).filter(
        TripSummary.thread_id == thread.id,
        TripSummary.user_id == user.id,
    ).order_by(TripSummary.created_at.desc()).first()

    return JSONResponse({
        "response":             response_text,
        "error":                "",
        "thread_id":            str(thread.id),
        "thread_title":         thread.title,
        "user_created_at":      fmt_utc(user_msg.created_at),
        "assistant_created_at": fmt_utc(ai_msg.created_at),
        "assistant_chat_id":    str(ai_msg.id),
        "source_id":            str(saved_source.id) if saved_source else None,
        "summary_id":           str(saved_summary.id)  if saved_summary else None,
        "trip_info":            trip_info,
        "flight_prefs":         flight_prefs,
        "travel_prefs":         travel_prefs,
    })


# Agentic RAG

@fastapi_app.post("/api/rag")
async def rag_endpoint(request: Request, db: Session = Depends(get_db)):
    user             = require_user(request, db)
    body             = await request.json()
    query            = (body.get("query") or "").strip()
    thread_id_raw = body.get("thread_id")
    sid              = body.get("sid") or ""
    attached_files   = body.get("attached_files") or []   # [{filename, db_id, file_url, has_preview}]


    thread_id = None
    if thread_id_raw:
        try:
            thread_id = uuid.UUID(str(thread_id_raw))
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid thread_id")

    if not query:
        raise HTTPException(status_code=400, detail="Query is required")

    thread = None
    if thread_id:
        thread = db.query(ChatThread).filter(ChatThread.id == thread_id, ChatThread.user_id == user.id).first()
    if not thread:
        thread = ChatThread(user_id=user.id, thread_type="rag", title=query[:60] + ("..." if len(query) > 60 else ""))
        db.add(thread); db.commit(); db.refresh(thread)


    user_msg = ChatMessage(
        thread_id=thread.id,
        user_id=user.id,
        role="user",
        content=query,
        attached_files=attached_files if attached_files else None,
    )
    db.add(user_msg)

    result = await run_rag_workflow(
        query=query,
        user_id=str(user.id),
        thread_id=str(thread.id),
        sid=sid,
    )
    answer = result.get("answer", "No answer generated.")

    ai_msg = ChatMessage(thread_id=thread.id, user_id=user.id, role="assistant", content=answer)
    db.add(ai_msg)
    thread.updated_at = datetime.utcnow()

    db.flush()  # get ai_msg.id before saving chunks
    assistant_chat_id = ai_msg.id

    # Save retrieved chunks + web URLs so artifact panel survives page reload
    documents_used = result.get("documents_used", [])
    web_urls       = result.get("web_urls", [])
    rag_source     = result.get("source", "direct")

    # Always save a record (even for direct/web) so reload knows the source
    chunk_rec = RagRetrievedChunk(
        user_id=user.id,
        thread_id=thread.id,
        assistant_chat_id=assistant_chat_id,
        chunks=documents_used if documents_used else None,
        web_urls=web_urls if web_urls else None,
        source=rag_source,
    )
    db.add(chunk_rec)

    # Auto-update thread title from first user message (like travel planner)
    user_msg_count = (
        db.query(ChatMessage)
        .filter(ChatMessage.thread_id == thread.id, ChatMessage.role == "user")
        .count()
    )
    if user_msg_count <= 1:
        thread.title = query[:60] + ("..." if len(query) > 60 else "")

    db.commit()
    db.refresh(user_msg)
    db.refresh(ai_msg)

    return JSONResponse({
        "answer":               answer,
        "source":               rag_source,
        "is_error":             result.get("is_error", False),
        "documents_used":       documents_used,
        "web_urls":             web_urls,
        "thread_id":            str(thread.id),
        "thread_title":         thread.title,
        "user_created_at":      fmt_utc(user_msg.created_at),
        "assistant_created_at": fmt_utc(ai_msg.created_at),
        "attached_files":       attached_files,
        "assistant_chat_id":    str(ai_msg.id),
    })


@fastapi_app.post("/api/rag/upload-attach")
async def rag_upload_attach(
    request: Request,
    files: List[UploadFile] = File(...),
    db: Session = Depends(get_db),
):
    """
    Upload up to 3 files for a single RAG message.
    Files are indexed in Pinecone AND stored on Cloudinary.
    Rejects (409) if the same user already uploaded the same document.
    """
    user = require_user(request, db)

    if len(files) > 3:
        raise HTTPException(status_code=400, detail="Maximum 3 files per message.")

    # ── Existing docs of THIS user only (filename + size) ──
    existing_keys = {
        ((d.filename or "").lower(), d.file_size)
        for d in db.query(UserDocument).filter(UserDocument.user_id == user.id).all()
    }

    # ── Pass 1: validate + duplicate check (nothing is uploaded yet) ──
    prepared    = []
    duplicates  = []
    batch_keys  = set()
    for file in files:
        ext = os.path.splitext(file.filename or "")[1].lower()
        ct  = (file.content_type or "").lower()
        if ext not in ALLOWED_EXTENSIONS and not any(a in ct for a in ["pdf", "word", "plain", "markdown"]):
            raise HTTPException(
                status_code=415,
                detail=f"{file.filename}: unsupported type. Use PDF, DOCX, TXT, or MD.",
            )

        content = await file.read()
        if len(content) > 50 * 1024 * 1024:
            raise HTTPException(status_code=413, detail=f"{file.filename} exceeds 50MB.")

        key = ((file.filename or "").lower(), len(content))
        if key in existing_keys or key in batch_keys:
            duplicates.append(file.filename)
            continue
        batch_keys.add(key)
        prepared.append((file, content))

    if duplicates:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "duplicate_document",
                "message": "This document is already uploaded.",
                "filenames": duplicates,
            },
        )

    # ── Pass 2: upload / index ──
    attached = []
    for file, content in prepared:
        storage_result = {"public_id": None, "url": None}
        try:
            storage_result = _upload_to_cloudinary(content, file.filename, user.id, file.content_type or "application/octet-stream")
        except Exception as e:
            print(f"[Cloudinary RAG attach] {e}")

        doc_id = await add_document_to_pinecone(
            file_content=content,
            filename=file.filename,
            content_type=file.content_type or "text/plain",
            user_id=str(user.id),
        )

        db_doc = UserDocument(
            user_id=user.id,
            filename=file.filename,
            pinecone_doc_id=doc_id,
            cloudinary_public_id=storage_result["public_id"],
            file_url="",
            file_size=len(content),
            content_type=file.content_type or "application/octet-stream",
        )
        db.add(db_doc)
        db.flush()

        attached.append({
            "doc_id":   doc_id,
            "db_id":    str(db_doc.id),
            "filename": file.filename,
            "file_url": "",
            "has_preview": bool(storage_result["public_id"]),
            "content_type": file.content_type or "application/octet-stream",
        })

    db.commit()
    return JSONResponse({"attached": attached, "count": len(attached)})

@fastapi_app.get("/api/rag/chunks/by-message/{assistant_chat_id}")
async def get_rag_chunks_by_message(assistant_chat_id: uuid.UUID, request: Request, db: Session = Depends(get_db)):
    """Fetch stored RAG retrieved chunks, web URLs, and source for a specific assistant message."""
    user = require_user(request, db)
    record = db.query(RagRetrievedChunk).filter(
        RagRetrievedChunk.assistant_chat_id == assistant_chat_id,
        RagRetrievedChunk.user_id == user.id,
    ).first()
    if not record:
        raise HTTPException(status_code=404, detail="No chunks found for this message")
    return JSONResponse({
        "assistant_chat_id": str(record.assistant_chat_id),
        "chunks":   record.chunks   or [],
        "web_urls": record.web_urls or [],
        "source":   record.source   or "direct",
    })



# Document Management

@fastapi_app.post("/api/docs/upload")
async def upload_documents(request: Request, files: List[UploadFile] = File(...), db: Session = Depends(get_db)):
    user = require_user(request, db)

    # ── Existing docs of THIS user only (filename + size) ──
    existing_keys = {
        ((d.filename or "").lower(), d.file_size)
        for d in db.query(UserDocument).filter(UserDocument.user_id == user.id).all()
    }

    # ── Pass 1: validate + duplicate check (nothing is uploaded yet) ──
    prepared   = []
    duplicates = []
    batch_keys = set()
    for file in files:
        ext = os.path.splitext(file.filename or "")[1].lower()
        ct  = (file.content_type or "").lower()
        if ext not in ALLOWED_EXTENSIONS and not any(a in ct for a in ["pdf", "word", "plain", "markdown"]):
            raise HTTPException(
                status_code=415,
                detail=f"{file.filename}: unsupported type. Upload PDF, DOCX, TXT, or MD files only.",
            )

        content = await file.read()
        if len(content) > 50 * 1024 * 1024:
            raise HTTPException(status_code=413, detail=f"{file.filename} exceeds 50MB limit")

        key = ((file.filename or "").lower(), len(content))
        if key in existing_keys or key in batch_keys:
            duplicates.append(file.filename)
            continue
        batch_keys.add(key)
        prepared.append((file, content))

    if duplicates:
        raise HTTPException(
            status_code=409,
            detail={
                "code": "duplicate_document",
                "message": "This document is already uploaded.",
                "filenames": duplicates,
            },
        )

    # ── Pass 2: upload / index ──
    uploaded = []
    for file, content in prepared:
        storage_result = {"public_id": None, "url": None}
        try:
            storage_result = _upload_to_cloudinary(content, file.filename, user.id, file.content_type or "application/octet-stream")
        except Exception as e:
            print(f"[Cloudinary upload] {e}")

        doc_id = await add_document_to_pinecone(
            file_content=content,
            filename=file.filename,
            content_type=file.content_type or "text/plain",
            user_id=str(user.id),
        )

        db.add(UserDocument(
            user_id=user.id,
            filename=file.filename,
            pinecone_doc_id=doc_id,
            cloudinary_public_id=storage_result["public_id"],
            file_url=storage_result["url"],
            file_size=len(content),
            content_type=file.content_type or "application/octet-stream",
        ))
        uploaded.append({"filename": file.filename, "doc_id": doc_id, "url": storage_result["url"]})

    db.commit()
    return JSONResponse({"uploaded": uploaded, "count": len(uploaded)})


@fastapi_app.get("/api/docs")
async def list_documents(request: Request, db: Session = Depends(get_db)):
    user = require_user(request, db)
    docs = db.query(UserDocument).filter(UserDocument.user_id == user.id).order_by(UserDocument.created_at.desc()).all()
    return JSONResponse([
        {
            "id":           str(d.id),
            "filename":     d.filename,
            "file_size":    d.file_size,
            "content_type": d.content_type,
            "has_preview":  bool(d.cloudinary_public_id),
            "created_at":   fmt_utc(d.created_at),
        }
        for d in docs
    ])


@fastapi_app.delete("/api/docs/{doc_id}")
async def delete_doc(doc_id: uuid.UUID, request: Request, db: Session = Depends(get_db)):
    user = require_user(request, db)
    doc  = db.query(UserDocument).filter(UserDocument.id == doc_id, UserDocument.user_id == user.id).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Document not found")
    if doc.pinecone_doc_id:
        await delete_document(pinecone_doc_id=doc.pinecone_doc_id, user_id=str(user.id))
    if doc.cloudinary_public_id:
        _delete_from_cloudinary(doc.cloudinary_public_id)
    db.delete(doc); db.commit()
    return JSONResponse({"ok": True})


@fastapi_app.get("/api/docs/{doc_id}/preview")
async def preview_doc(doc_id: uuid.UUID, request: Request, db: Session = Depends(get_db)):
    """
    Stream a user's document from Cloudinary through the backend.

    Cloudinary files are stored as:
        resource_type = raw
        type          = authenticated

    The signed Cloudinary URL is generated server-side and is
    never exposed to the browser.
    """

    import httpx

    user = require_user(request, db)

    doc = (
        db.query(UserDocument)
        .filter(
            UserDocument.id == doc_id,
            UserDocument.user_id == user.id
        )
        .first()
    )

    if not doc:
        raise HTTPException(
            status_code=404,
            detail="Document not found"
        )

    if not doc.cloudinary_public_id:
        raise HTTPException(
            status_code=404,
            detail="No cloud copy available for this document"
        )


    # Generate a proper Cloudinary authenticated download URL

    signed_url = _get_cloudinary_download_url(
        doc.cloudinary_public_id
    )

    if not signed_url:
        raise HTTPException(
            status_code=500,
            detail="Could not generate Cloudinary download URL"
        )

    
    # Determine response content type
    
    ext = os.path.splitext(doc.filename or "")[1].lower()

    content_type_map = {
        ".pdf": "application/pdf",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".doc": "application/msword",
        ".txt": "text/plain; charset=utf-8",
        ".md": "text/plain; charset=utf-8",
    }

    content_type = content_type_map.get(
        ext,
        doc.content_type or "application/octet-stream"
    )


    # Fetch file from Cloudinary

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(
                connect=10.0,
                read=60.0,
                write=60.0,
                pool=10.0,
            ),
            follow_redirects=True,
        ) as client:

            upstream = await client.get(signed_url)

            # Log Cloudinary's actual error when something goes wrong.
            if upstream.status_code >= 400:
                cloudinary_error = upstream.headers.get(
                    "X-Cld-Error",
                    ""
                )

                print(
                    "[preview_doc] Cloudinary request failed: "
                    f"status={upstream.status_code}, "
                    f"error={cloudinary_error}, "
                    f"url={signed_url}"
                )

                raise HTTPException(
                    status_code=502,
                    detail=(
                        "Cloudinary rejected the document download"
                        + (
                            f": {cloudinary_error}"
                            if cloudinary_error
                            else ""
                        )
                    )
                )

            file_bytes = upstream.content

    except HTTPException:
        raise

    except httpx.HTTPError as e:
        print(f"[preview_doc] HTTP error while fetching Cloudinary file: {e}")

        raise HTTPException(
            status_code=502,
            detail="Could not fetch file from Cloudinary"
        )

    except Exception as e:
        print(f"[preview_doc] Unexpected Cloudinary fetch error: {e}")

        raise HTTPException(
            status_code=502,
            detail="Could not fetch file from storage"
        )

    # Browser behavior
    #
    # PDF/TXT/MD:
    #   Display inline.
    #
    # DOC/DOCX:
    #   Download because browsers do not natively render
    #   these formats consistently.
    #
    disposition = (
        "inline"
        if ext in (".pdf", ".txt", ".md")
        else "attachment"
    )

    safe_filename = (
        (doc.filename or "document")
        .replace("\\", "_")
        .replace('"', "_")
        .replace("\r", "_")
        .replace("\n", "_")
    )

    return StreamingResponse(
        io.BytesIO(file_bytes),
        media_type=content_type,
        headers={
            "Content-Disposition": (
                f'{disposition}; filename="{safe_filename}"'
            ),
            "Content-Length": str(len(file_bytes)),
            "Cache-Control": "private, no-store, max-age=0",
            "X-Content-Type-Options": "nosniff",
        },
    )
    

# @fastapi_app.get("/api/debug/chroma/{user_id}")
# async def debug_chroma(user_id: str, request: Request, db: Session = Depends(get_db)):
#     from rag_backend import get_collection
#     collection   = get_collection()
#     by_string    = collection.get(where={"user_id": {"$eq": user_id}})
#     all_docs     = collection.get()
#     all_user_ids = list({m["user_id"] for m in all_docs["metadatas"]}) if all_docs["metadatas"] else []
#     user         = db.query(User).filter(User.id == int(user_id)).first()
#     db_docs      = db.query(UserDocument).filter(UserDocument.user_id == int(user_id)).all() if user else []
#     return {
#         "queried_user_id":        user_id,
#         "chroma_chunks_found":    len(by_string["ids"]),
#         "all_user_ids_in_chroma": all_user_ids,
#         "db_documents":           [{"filename": d.filename, "chroma_doc_id": d.chroma_doc_id} for d in db_docs],
#         "total_chunks_in_chroma": len(all_docs["ids"]),
#     }



# Trip Reports

@fastapi_app.get("/api/reports")
async def list_reports(request: Request, db: Session = Depends(get_db)):
    user    = require_user(request, db)
    reports = (
        db.query(TripReport)
        .filter(TripReport.user_id == user.id)
        .order_by(TripReport.created_at.desc())
        .limit(60)
        .all()
    )
    return JSONResponse([
        {
            "id":         str(r.id),
            "thread_id":  str(r.thread_id),
            "title":      r.title,
            "content":    r.content,
            "created_at": fmt_utc(r.created_at),
        }
        for r in reports
    ])


@fastapi_app.post("/api/export/pdf")
async def export_pdf(request: Request, db: Session = Depends(get_db)):
    user    = require_user(request, db)
    body    = await request.json()
    content = (body.get("content") or "").strip()
    if not content:
        raise HTTPException(status_code=400, detail="Content is required")
    try:
        pdf_bytes = _markdown_to_pdf_bytes(content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF generation failed: {e}")
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="trip-plan-{user.id}.pdf"',
            "Content-Length": str(len(pdf_bytes)),
        },
    )



# Trip Sources

@fastapi_app.get("/api/sources/by-message/{assistant_chat_id}")
async def get_source_by_message(assistant_chat_id: uuid.UUID, request: Request, db: Session = Depends(get_db)):
    """Fetch TripSource linked to a specific assistant chat message id."""
    user   = require_user(request, db)
    source = db.query(TripSource).filter(
        TripSource.assistant_chat_id == assistant_chat_id,
        TripSource.user_id == user.id,
    ).order_by(TripSource.created_at.desc()).first()
    if not source:
        raise HTTPException(status_code=404, detail="Source not found for this message")
    return JSONResponse({
        "id":                   str(source.id),
        "assistant_chat_id":    str(source.assistant_chat_id),
        "flight_results_text":  source.flight_results_text or "",
        "destination_urls":     source.destination_urls or {},
        "created_at":           fmt_utc(source.created_at),
    })


@fastapi_app.get("/api/summary/by-message/{assistant_chat_id}")
async def get_summary_by_message(assistant_chat_id: uuid.UUID, request: Request, db: Session = Depends(get_db)):
    """Fetch TripSummary linked to a specific assistant chat message id."""
    user    = require_user(request, db)
    summary = db.query(TripSummary).filter(
        TripSummary.assistant_chat_id == assistant_chat_id,
        TripSummary.user_id == user.id,
    ).order_by(TripSummary.created_at.desc()).first()
    if not summary:
        raise HTTPException(status_code=404, detail="Summary not found for this message")
    return JSONResponse({
        "id":           str(summary.id),
        "assistant_chat_id": str(summary.assistant_chat_id),
        "trip_info":    summary.trip_info or {},
        "flight_prefs": summary.flight_prefs or {},
        "travel_prefs": summary.travel_prefs or {},
        "created_at":   fmt_utc(summary.created_at),
    })


@fastapi_app.get("/api/pdf/by-message/{assistant_chat_id}")
async def export_pdf_by_message( assistant_chat_id: uuid.UUID, request: Request, db: Session = Depends(get_db)):
    """Export PDF for a specific assistant message's trip report."""
    user   = require_user(request, db)
    report = db.query(TripReport).filter(
        TripReport.assistant_chat_id == assistant_chat_id,
        TripReport.user_id == user.id,
    ).order_by(TripReport.created_at.desc()).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found for this message")
    try:
        pdf_bytes = _markdown_to_pdf_bytes(report.content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF generation failed: {e}")
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="trip-plan-msg-{assistant_chat_id}.pdf"',
            "Content-Length": str(len(pdf_bytes)),
        },
    )


@fastapi_app.get("/api/sources/{source_id}")
async def get_trip_source(source_id: uuid.UUID,request: Request, db: Session = Depends(get_db)):
    user   = require_user(request, db)
    source = db.query(TripSource).filter(
        TripSource.id == source_id,
        TripSource.user_id == user.id,
    ).first()
    if not source:
        raise HTTPException(status_code=404, detail="Source not found")
    return JSONResponse({
        "id":                   str(source.id),
        "flight_results_text":  source.flight_results_text or "",
        "destination_urls":     source.destination_urls or {},
        "created_at":           fmt_utc(source.created_at),
    })


@fastapi_app.get("/api/threads/{thread_id}/sources")
async def get_thread_sources(thread_id: uuid.UUID, request: Request, db: Session = Depends(get_db)):
    user   = require_user(request, db)
    source = db.query(TripSource).filter(
        TripSource.thread_id == thread_id,
        TripSource.user_id == user.id,
    ).order_by(TripSource.created_at.desc()).first()
    if not source:
        raise HTTPException(status_code=404, detail="No sources found for this thread")
    return JSONResponse({
        "id":                   str(source.id),
        "flight_results_text":  source.flight_results_text or "",
        "destination_urls":     source.destination_urls or {},
        "created_at":           fmt_utc(source.created_at),
    })


@fastapi_app.get("/api/threads/{thread_id}/summary")
async def get_thread_summary(thread_id: uuid.UUID, request: Request, db: Session = Depends(get_db)):
    user    = require_user(request, db)
    summary = db.query(TripSummary).filter(
        TripSummary.thread_id == thread_id,
        TripSummary.user_id == user.id,
    ).order_by(TripSummary.created_at.desc()).first()
    if not summary:
        raise HTTPException(status_code=404, detail="No summary found for this thread")
    return JSONResponse({
        "id":           str(summary.id),
        "trip_info":    summary.trip_info or {},
        "flight_prefs": summary.flight_prefs or {},
        "travel_prefs": summary.travel_prefs or {},
        "created_at":   fmt_utc(summary.created_at),
    })


@fastapi_app.get("/api/export/pdf-from-source/{source_id}")
async def export_pdf_from_source(source_id: uuid.UUID,request: Request, db: Session = Depends(get_db)):
    """Export PDF for a stored source/report by source_id."""
    user   = require_user(request, db)
    # Find the matching report for this thread
    source = db.query(TripSource).filter(
        TripSource.id == source_id,
        TripSource.user_id == user.id,
    ).first()
    if not source:
        raise HTTPException(status_code=404, detail="Source not found")
    report = db.query(TripReport).filter(
        TripReport.thread_id == source.thread_id,
        TripReport.user_id == user.id,
    ).order_by(TripReport.created_at.desc()).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    try:
        pdf_bytes = _markdown_to_pdf_bytes(report.content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"PDF generation failed: {e}")
    return StreamingResponse(
        io.BytesIO(pdf_bytes),
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="trip-plan-{source.thread_id}.pdf"',
            "Content-Length": str(len(pdf_bytes)),
        },
    )



# Profile & Country Setup

@fastapi_app.get("/api/profile")
async def get_profile(request: Request, db: Session = Depends(get_db)):
    user = require_user(request, db)
    # Trips planned = number of travel threads
    trips_count = db.query(ChatThread).filter(
        ChatThread.user_id == user.id,
        ChatThread.thread_type == "travel"
    ).count()
    # Reports saved
    reports_count = db.query(TripReport).filter(TripReport.user_id == user.id).count()
    # Recent trips — last 6 trip reports with their summary info
    recent_reports = (
        db.query(TripReport)
        .filter(TripReport.user_id == user.id)
        .order_by(TripReport.created_at.desc())
        .limit(6)
        .all()
    )
    recent_trips = []
    for r in recent_reports:
        destination_city = None
        trip_summary_id  = None
        if r.trip_summary_id:
            summary = db.query(TripSummary).filter(
                TripSummary.id == r.trip_summary_id
            ).first()
            if summary and summary.trip_info:
                destination_city = summary.trip_info.get("destination_city")
                trip_summary_id  = summary.id
        # Fall back to parsing the report title
        if not destination_city and r.title:
            import re as _re
            m = _re.search(r'(?:to\s+)([A-Za-z\s]+?)(?:\s*$|\.\.\.)', r.title, _re.IGNORECASE)
            if m:
                destination_city = m.group(1).strip()
        recent_trips.append({
            "thread_id":          str(r.thread_id) if r.thread_id else None,
            "assistant_chat_id":  str(r.assistant_chat_id) if r.assistant_chat_id else None,
            "trip_summary_id":    str(trip_summary_id) if trip_summary_id else None,
            "title":              r.title,
            "destination_city":   destination_city or r.title,
            "updated_at":         fmt_utc(r.created_at),
        })

    return JSONResponse({
        "id":            str(user.id),
        "name":          user.name,
        "email":         user.email,
        "picture":       user.picture or "",
        "country":       user.country or "",
        "member_since":  fmt_utc(user.created_at),
        "trips_planned": trips_count,
        "reports_saved": reports_count,
        "recent_trips":  recent_trips,
    })


@fastapi_app.patch("/api/profile")
async def update_profile(request: Request, db: Session = Depends(get_db)):
    user = require_user(request, db)
    body = await request.json()
    name    = (body.get("name") or "").strip()
    country = (body.get("country") or "").strip()
    if name:
        user.name = name[:255]
    if country:
        user.country = country[:100]
    db.commit()
    db.refresh(user)
    return JSONResponse({"ok": True, "name": user.name, "country": user.country})


@fastapi_app.get("/api/profile/needs-country")
async def needs_country(request: Request, db: Session = Depends(get_db)):
    """Returns true if user hasn't set their country yet (first login)."""
    user = get_current_user(request, db)
    if not user:
        return JSONResponse({"needs_country": False})
    return JSONResponse({"needs_country": not bool(user.country)})


@fastapi_app.get("/api/city-image")
async def city_image(
    request: Request,
    city: str = "",
    trip_summary_id: uuid.UUID = None,
    db: Session = Depends(get_db),
):
    """
    Proxy Pixabay image search — keeps API key server-side.
    Works for both logged-in and logged-out users.
    If trip_summary_id is given, resolve destination_city from that summary row directly.
    """
    # Auth is optional — logged-out users can still get images
    user = get_current_user(request, db)

    # Resolve city from trip_summaries when trip_summary_id supplied (auth required)
    if trip_summary_id and user:
        summary = db.query(TripSummary).filter(
            TripSummary.id == trip_summary_id
        ).first()
        if summary and summary.trip_info:
            resolved = summary.trip_info.get("destination_city", "").strip()
            if resolved:
                city = resolved

    city = city.strip()
    if not city or city.lower() in ("new trip", ""):
        return JSONResponse({"url": None, "city": ""})

    # Use city-specific landmark query — avoid generic travel photos
    query = f"{city} nature"

    try:
        res = requests.get(
            "https://pixabay.com/api/",
            params={
                "key":         os.getenv("PIXABAY_API_KEY"),
                "q":           query,
                "image_type":  "photo",
                "orientation": "horizontal",
                "category":    "travel",
                "per_page":    10,
                "safesearch":  "true",
                "order":       "popular",
            },
            timeout=5,
        )
        hits = res.json().get("hits", [])

        # Filter hits where tags actually contain the city name (case-insensitive)
        city_lower = city.lower()
        city_hits  = [h for h in hits if city_lower in h.get("tags", "").lower()]
        best       = city_hits[0] if city_hits else (hits[0] if hits else None)
        url        = best["webformatURL"] if best else None
        return JSONResponse({"url": url, "city": city})
    except Exception as e:
        print(f"Pixabay error: {e}")
        return JSONResponse({"url": None, "city": city})




# Reports — filtered + favourite + feedback

@fastapi_app.get("/api/reports/categorised")
async def list_reports_categorised(request: Request, db: Session = Depends(get_db)):
    """
    Returns reports split into upcoming, live, and past buckets.
    Dates are resolved from the linked TripSummary.trip_info JSON.
    """
    user = require_user(request, db)
    today = _date.today()

    reports = (
        db.query(TripReport)
        .filter(TripReport.user_id == user.id)
        .order_by(TripReport.created_at.desc())
        .limit(120)
        .all()
    )

    upcoming, live, past = [], [], []

    for r in reports:
        start_date = end_date = None
        destination_city = None
        trip_summary_id = None

        if r.trip_summary_id:
            summary = db.query(TripSummary).filter(TripSummary.id == r.trip_summary_id).first()
            if summary and summary.trip_info:
                raw_start = summary.trip_info.get("start_date")
                raw_end   = summary.trip_info.get("end_date")
                destination_city = summary.trip_info.get("destination_city")
                trip_summary_id  = summary.id
                try:
                    start_date = datetime.strptime(raw_start, "%Y-%m-%d").date() if raw_start else None
                    end_date   = datetime.strptime(raw_end,   "%Y-%m-%d").date() if raw_end   else None
                except (ValueError, TypeError):
                    pass

        if not destination_city and r.title:
            import re as _re
            m = _re.search(r'(?:to\s+)([A-Za-z\s]+?)(?:\s*$|\.\.\.)', r.title, _re.IGNORECASE)
            if m:
                destination_city = m.group(1).strip()

        record = {
            "id":                str(r.id),
            "thread_id":         str(r.thread_id),
            "assistant_chat_id": str(r.assistant_chat_id) if r.assistant_chat_id else None,
            "trip_summary_id":   str(trip_summary_id) if trip_summary_id else None,
            "title":             r.title,
            "content":           r.content,
            "is_favourite":      bool(r.is_favourite),
            "feedback":          r.feedback,
            "destination_city":  destination_city or r.title,
            "start_date":        str(start_date) if start_date else None,
            "end_date":          str(end_date)   if end_date   else None,
            "created_at":        fmt_utc(r.created_at),
        }

        if start_date and end_date:
            if today < start_date:
                upcoming.append(record)
            elif start_date <= today <= end_date:
                live.append(record)
            else:
                past.append(record)
        else:
            # No date info — fall into past by default
            past.append(record)

    return JSONResponse({"upcoming": upcoming, "live": live, "past": past})


@fastapi_app.patch("/api/reports/{report_id}/favourite")
async def toggle_favourite(report_id: uuid.UUID, request: Request, db: Session = Depends(get_db)):
    user   = require_user(request, db)
    report = db.query(TripReport).filter(
        TripReport.id == report_id, TripReport.user_id == user.id
    ).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    report.is_favourite = 0 if report.is_favourite else 1
    db.commit()
    return JSONResponse({"id": str(report.id), "is_favourite": bool(report.is_favourite)})


@fastapi_app.patch("/api/reports/{report_id}/feedback")
async def set_feedback(report_id: uuid.UUID, request: Request, db: Session = Depends(get_db)):
    user   = require_user(request, db)
    body   = await request.json()
    value  = body.get("feedback")  # 'like' | 'dislike' | null
    if value not in ("like", "dislike", None):
        raise HTTPException(status_code=400, detail="Invalid feedback value")
    report = db.query(TripReport).filter(
        TripReport.id == report_id, TripReport.user_id == user.id
    ).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    report.feedback = value
    db.commit()
    return JSONResponse({"id": str(report.id), "feedback": report.feedback})


# Health

@fastapi_app.get("/health")
async def health():
    return {"status": "ok", "service": "Trip Swarm"}


if __name__ == "__main__":
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True, log_level="info")