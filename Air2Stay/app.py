"""
Air2Stay — DCT Abu Dhabi · NSTI 2026

Streamlit wrapper for the standalone Air2Stay HTML prototype.
"""

import base64
import json
import os
import pathlib
import re
import secrets
import ssl
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import streamlit as st
import certifi


st.set_page_config(
    page_title="Air2Stay · DCT Abu Dhabi",
    page_icon="✈",
    layout="wide",
    initial_sidebar_state="collapsed",
)


# Hide Streamlit chrome and remove page padding.
st.markdown(
    """
    <style>
    #MainMenu,
    header,
    footer,
    [data-testid="stToolbar"],
    [data-testid="stDecoration"],
    [data-testid="stStatusWidget"],
    section[data-testid="stSidebar"] {
        display: none !important;
    }

    .block-container {
        padding: 0 !important;
        margin: 0 !important;
        max-width: 100% !important;
    }

    html,
    body,
    [data-testid="stAppViewContainer"],
    [data-testid="stAppViewContainer"] > .main,
    .stApp {
        overflow: visible !important;
    }

    iframe {
        border: none;
        display: block;
        width: 100%;
        height: 100vh !important;
        min-height: 100vh;
        overflow-y: auto;
    }
    </style>
    """,
    unsafe_allow_html=True,
)


ROOT = pathlib.Path(__file__).parent
PROTOTYPE_DIR = ROOT / "prototype"
HTML_FILE = PROTOTYPE_DIR / "index.html"
GEMINI_BRIDGE_PORT = 8767
GEMINI_MODEL = "gemini-3.1-flash-lite"


def load_local_env() -> None:
    """Load simple KEY=value entries from the ignored local .env file."""
    env_file = ROOT / ".env"
    if not env_file.is_file():
        return
    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        name, value = name.strip(), value.strip().strip("\"'")
        if name and value:
            os.environ.setdefault(name, value)


@st.cache_resource(show_spinner=False)
def start_gemini_bridge():
    """Serve a small loopback-only bridge so the browser never receives the key."""
    load_local_env()
    token = secrets.token_urlsafe(32)

    class GeminiHandler(BaseHTTPRequestHandler):
        def _send(self, status: int, payload: dict) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            origin = self.headers.get("Origin", "")
            if origin in {"null", "http://localhost:8765", "http://127.0.0.1:8765"}:
                self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Air2Stay-Token")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self) -> None:
            self._send(204, {})

        def do_POST(self) -> None:
            if not secrets.compare_digest(self.headers.get("X-Air2Stay-Token", ""), token):
                self._send(403, {"error": "Refresh Air2Stay to reconnect the assistant."})
                return
            if self.headers.get("Origin", "") not in {"null", "http://localhost:8765", "http://127.0.0.1:8765"}:
                self._send(403, {"error": "This local assistant only accepts requests from Air2Stay."})
                return
            if self.path != "/ask":
                self._send(404, {"error": "Not found"})
                return
            key = os.environ.get("GEMINI_API_KEY", "").strip()
            if not key:
                self._send(503, {"error": "Gemini is not configured yet. Add GEMINI_API_KEY to your local .env file and restart Air2Stay."})
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if size < 1 or size > 20000:
                    self._send(400, {"error": "Please send a shorter question."})
                    return
                incoming = json.loads(self.rfile.read(size).decode("utf-8"))
                question = str(incoming.get("question", "")).strip()[:1200]
                context = incoming.get("context", {})
                if not question:
                    self._send(400, {"error": "Please enter a question."})
                    return
                prompt = (
                    "You are Air2Stay's friendly planning assistant for a UAE hotel-demand scenario tool. "
                    "Write for someone with no technical background. Start with one short direct sentence. "
                    "Then, only if useful, give up to three short bullet points with a blank line between them. "
                    "Aim for under 100 words unless the user asks for detail. Use everyday words: say 'check' instead of 'validate', "
                    "and 'compare' instead of 'benchmark'. Avoid long introductions, jargon and repeating the dashboard numbers. "
                    "For next-step questions, suggest concrete checks such as airline demand, available hotel rooms, and visitor stay length. "
                    "Use only the supplied current plan facts and assumptions. "
                    "Never invent numbers, sources, or measured event impacts. If a fact is missing, say so. "
                    "The app's deterministic calculation engine owns all numeric results. Explain them, but do not recalculate or change the plan.\n\n"
                    f"Current plan facts (JSON): {json.dumps(context, ensure_ascii=False)[:9000]}\n\n"
                    f"User question: {question}"
                )
                request_body = json.dumps({
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {"temperature": 0.2, "maxOutputTokens": 450,
                                         "thinkingConfig": {"thinkingLevel": "minimal"}},
                }).encode("utf-8")
                request = Request(
                    f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent",
                    data=request_body,
                    headers={"Content-Type": "application/json", "x-goog-api-key": key},
                    method="POST",
                )
                with urlopen(request, timeout=40, context=ssl.create_default_context(cafile=certifi.where())) as response:
                    result = json.loads(response.read().decode("utf-8"))
                answer = "".join(
                    part.get("text", "")
                    for candidate in result.get("candidates", [])
                    for part in candidate.get("content", {}).get("parts", [])
                ).strip()
                if not answer:
                    self._send(502, {"error": "Gemini did not return an answer. Please try again."})
                    return
                self._send(200, {"answer": answer})
            except HTTPError as exc:
                message = "Gemini could not answer. Check that the key has API access and try again."
                if exc.code == 429:
                    message = "Gemini's request limit was reached. Please try again later."
                self._send(502, {"error": message})
            except (URLError, TimeoutError):
                self._send(502, {"error": "Could not reach Gemini. Check the internet connection and try again."})
            except (ValueError, json.JSONDecodeError):
                self._send(400, {"error": "The request could not be read. Please try again."})
            except Exception:
                self._send(500, {"error": "The assistant had a problem. Air2Stay's planner is still available."})

        def log_message(self, _format: str, *_args) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", GEMINI_BRIDGE_PORT), GeminiHandler)
    server.token = token
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


try:
    load_local_env()
    gemini_bridge = start_gemini_bridge() if os.environ.get("GEMINI_API_KEY") else None
except OSError:
    gemini_bridge = None
    st.warning("The planner is ready, but the local assistant connection could not start. Close other Air2Stay sessions and restart the app.")


@st.cache_data(show_spinner=False, max_entries=2)
def load_prototype_html(asset_signature: tuple) -> str:
    """Load the standalone prototype and make it self-contained."""

    required_files = {
        "prototype HTML": HTML_FILE,
        "prototype CSS": PROTOTYPE_DIR / "styles.css",
        "scenario data": PROTOTYPE_DIR / "data" / "scenario_data.json",
        "country location reference": PROTOTYPE_DIR / "data" / "country_locations.json",
        "map SVG": PROTOTYPE_DIR / "data" / "admin0-countries.svg",
        "scenario engine": PROTOTYPE_DIR / "engine.mjs",
        "prototype controller": PROTOTYPE_DIR / "app.mjs",
        "comparison-market helpers": PROTOTYPE_DIR / "route_planning.mjs",
        "decision tools": PROTOTYPE_DIR / "decision_tools.mjs",
        "conversion evidence": PROTOTYPE_DIR / "conversion_evidence.mjs",
    }
    missing = [f"{label}: {path}" for label, path in required_files.items() if not path.is_file()]
    if missing:
        raise FileNotFoundError("Missing required Air2Stay assets:\n" + "\n".join(missing))

    html = HTML_FILE.read_text(encoding="utf-8")

    # -------------------------------------------------------------
    # Inline CSS
    # -------------------------------------------------------------
    css_path = PROTOTYPE_DIR / "styles.css"

    if css_path.exists():
        css = css_path.read_text(encoding="utf-8")

        html = re.sub(
            r'<link\s+rel="stylesheet"\s+href=["\']'
            r'\./styles\.css[^"\']*["\']\s*/?>',
            f"<style>\n{css}\n</style>",
            html,
            count=1,
        )

    # -------------------------------------------------------------
    # Inline scenario data
    # -------------------------------------------------------------
    json_path = PROTOTYPE_DIR / "data" / "scenario_data.json"
    country_locations_path = PROTOTYPE_DIR / "data" / "country_locations.json"

    if json_path.exists() and country_locations_path.exists():
        json_text = json_path.read_text(encoding="utf-8")
        locations_text = country_locations_path.read_text(encoding="utf-8")

        injection = (
            "<script>\n"
            "window.__AIR2STAY_SCENARIO_DATA__ = "
            f"{json_text};\n"
            "window.__AIR2STAY_COUNTRY_LOCATIONS__ = "
            f"{locations_text};\n"
            "</script>\n"
        )

        html = html.replace(
            "<head>",
            "<head>\n" + injection,
            1,
        )

    # -------------------------------------------------------------
    # Inline map SVG
    # -------------------------------------------------------------
    svg_path = PROTOTYPE_DIR / "data" / "admin0-countries.svg"

    if svg_path.exists():
        svg_b64 = base64.b64encode(
            svg_path.read_bytes()
        ).decode("ascii")

        svg_uri = (
            "data:image/svg+xml;base64,"
            + svg_b64
        )

        html = re.sub(
            r'href=["\']'
            r'\./data/admin0-countries\.svg[^"\']*'
            r'["\']',
            f'href="{svg_uri}"',
            html,
        )

    # -------------------------------------------------------------
    # Inline engine.mjs + app.mjs
    # -------------------------------------------------------------
    engine_path = PROTOTYPE_DIR / "engine.mjs"
    app_path = PROTOTYPE_DIR / "app.mjs"

    if engine_path.exists() and app_path.exists():

        engine_src = engine_path.read_text(
            encoding="utf-8"
        )

        app_src = app_path.read_text(
            encoding="utf-8"
        )
        engine_src = re.sub(r"(?m)^(\s*)export\s+", r"\1", engine_src)

        # Remove the ES-module import because engine.mjs
        # is placed directly before app.mjs.
        app_src = re.sub(
            r'import\s*\{[^}]+\}\s*'
            r'from\s*["\']\.\/[^"\']+\.mjs[^"\']*["\'];?\s*',
            "",
            app_src,
            flags=re.MULTILINE,
        )
        app_src = app_src.replace(
            "./data/admin0-countries.svg?v=20260922-admin0",
            svg_uri,
        )

        # Replace the COMPLETE original data-loading block.
        #
        # Original:
        #
        # const response = await fetch("./data/scenario_data.json");
        # if (!response.ok) throw new Error(...);
        # data = await response.json();
        #
        # We replace all three lines together so that
        # "response" can never remain referenced.
        app_src = re.sub(
            r'const\s+response\s*=\s*await\s+fetch\('
            r'\s*["\']\.\/data\/scenario_data\.json["\']\s*'
            r'\)\s*;\s*'
            r'if\s*\(\s*!response\.ok\s*\)\s*'
            r'throw\s+new\s+Error\([^;]*\)\s*;\s*'
            r'data\s*=\s*await\s+response\.json\(\)\s*;\s*',
            "data = window.__AIR2STAY_SCENARIO_DATA__;\n",
            app_src,
            count=1,
            flags=re.MULTILINE,
        )

        helper_sources = []
        for helper_name in ("route_planning.mjs", "decision_tools.mjs", "conversion_evidence.mjs"):
            helper_src = (PROTOTYPE_DIR / helper_name).read_text(encoding="utf-8")
            helper_src = re.sub(r'import\s*\{[^}]+\}\s*from\s*["\']\./[^"\']+["\'];?\s*', "", helper_src)
            helper_sources.append(re.sub(r"(?m)^(\s*)export\s+", r"\1", helper_src))
        combined = (
            "// Air2Stay engine.mjs — inlined\n"
            + engine_src
            + "\n\n" + "\n\n".join(helper_sources)
            + "\n\n"
            "// Air2Stay app.mjs — inlined\n"
            + app_src
        )

        combined_b64 = base64.b64encode(
            combined.encode("utf-8")
        ).decode("ascii")

        combined_uri = (
            "data:text/javascript;base64,"
            + combined_b64
        )

        # Replace the original module script.
        html = re.sub(
            r'<script\s+type="module"\s+'
            r'src=["\']\.\/app\.mjs[^"\']*["\']'
            r'\s*>\s*</script>',
            f'<script type="module" src="{combined_uri}"></script>',
            html,
            count=1,
        )

    return html


# -------------------------------------------------------------
# Render prototype
# -------------------------------------------------------------
try:
    asset_signature = tuple((str(path.relative_to(PROTOTYPE_DIR)), path.stat().st_mtime_ns) for path in sorted(PROTOTYPE_DIR.rglob("*")) if path.is_file() and path.suffix in {".html", ".css", ".mjs", ".json", ".svg"})
    page_html = load_prototype_html(asset_signature)
    shared_plan = st.query_params.get("plan", "")
    config = {"sharedPlan": shared_plan if len(shared_plan) <= 20000 else "invalid", "appUrl": "http://localhost:8765/", "assistantToken": gemini_bridge.token if gemini_bridge else ""}
    config_b64 = base64.b64encode(json.dumps(config).encode("utf-8")).decode("ascii")
    config_script = f'<script>(() => {{ const config = JSON.parse(atob("{config_b64}")); window.__AIR2STAY_SHARED_PLAN__ = config.sharedPlan; window.__AIR2STAY_APP_URL__ = config.appUrl; window.__AIR2STAY_ASSISTANT_TOKEN__ = config.assistantToken; }})();</script>'
    page_html = page_html.replace("<head>", "<head>" + config_script, 1)

    st.components.v1.html(
        page_html,
        height=900,
        scrolling=True,
    )

except FileNotFoundError as exc:
    st.error(str(exc))

except Exception as exc:
    st.error("Air2Stay could not start")
    st.exception(exc)
