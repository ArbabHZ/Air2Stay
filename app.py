"""
Air2Stay — DCT Abu Dhabi · NSTI 2026

Streamlit wrapper for the standalone Air2Stay HTML prototype.
"""

import base64
import pathlib
import re

import streamlit as st


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


def load_prototype_html() -> str:
    """Load the standalone prototype and make it self-contained."""

    if not HTML_FILE.exists():
        raise FileNotFoundError(
            f"Prototype not found: {HTML_FILE}"
        )

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

    if json_path.exists():
        json_text = json_path.read_text(encoding="utf-8")

        injection = (
            "<script>\n"
            "window.__AIR2STAY_SCENARIO_DATA__ = "
            f"{json_text};\n"
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
        engine_src = re.sub(r"\bexport\s+", "", engine_src)

        # Remove the ES-module import because engine.mjs
        # is placed directly before app.mjs.
        app_src = re.sub(
            r'import\s*\{[^}]+\}\s*'
            r'from\s*["\']\.\/engine\.mjs[^"\']*["\'];?\s*',
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

        combined = (
            "// Air2Stay engine.mjs — inlined\n"
            + engine_src
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
    page_html = load_prototype_html()

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
