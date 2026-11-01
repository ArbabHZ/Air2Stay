# Air2Stay Scenario Copilot

A sophisticated flight-to-hotel demand forecasting system for the Abu Dhabi Department of Culture and Tourism (DCT). Air2Stay combines historical flight data with hotel occupancy patterns to enable strategic scenario planning and market analysis.

![Status](https://img.shields.io/badge/status-prototype-blue) ![Python](https://img.shields.io/badge/python-3.12+-blue) ![License](https://img.shields.io/badge/license-proprietary-red)

## 🎯 Overview

Air2Stay predicts how changes in flight capacity and routing impact hotel demand across 45+ nationalities. The system supports:

- **Scenario Planning**: Adjust flight frequency, capacity, load factors, and guest behavior
- **Country Bridge**: Map departure countries to guest nationalities with data-driven confidence
- **Transparent Calculation**: Every assumption is visible and adjustable
- **Historical Validation**: Closed-book testing against actual hotel data
- **Sensitivity Analysis**: Identify which variables drive outcomes most

## 🚀 Quick Start & PDF Access

### Project PDF Report & Presentation
- **`ppt/Air2Stay.pdf`** — The complete executive presentation and project report.
- **`ppt/Air2Stay.pptx`** — PowerPoint source presentation.

### Prerequisites
- Python 3.12+ with the packages listed in `requirements.txt` installed
- The project files in this folder

### Installation & Running

**Option 1: Streamlit app (recommended)**
```bash
python -m pip install -r requirements.txt
python run_local.py --check
python run_local.py
```
Then open http://localhost:8765 in your browser.

On Windows, you can run `run_prototype.ps1` instead. If you use npm, the same app can be started with `npm start` or `npm run dev`.

`npm start` uses the project's `.venv` when it exists. The local configuration binds Air2Stay to this computer only.

The launcher checks all required files and names anything missing before opening the app. It works with an installed Python environment even when a copied project has no `.venv`. If packages are missing, it prints the installation command for the selected environment. Windows users can run `run_prototype.ps1 --check` before starting.

**Prepare a complete presentation copy**

Run `python run_local.py --package Air2Stay-demo.zip`. This creates a ZIP from the current required application files, including all imported helper modules, the country locations, map, scenario data, configuration and empty key example. It excludes `.env`, `.venv` and raw competition workbooks. Extract it on the demo computer, install `requirements.txt`, then run `python run_local.py --check` followed by `python run_local.py`. The local key must be configured separately for open-ended Gemini chat. Handle the ZIP as competition-only data.

The package command includes required local changes even before a Git commit. For a Git-based handoff, include all required files listed by the launcher; an older commit will not contain newly added helpers or location data. Do not commit `.env` or raw competition workbooks.

Run `python tests/startup.py` to test package contents, a fresh copy without `.venv`, and clear errors for missing assets/imported helpers. This verifies the copy using the installed Python packages; it does not download or test a clean package installation.

Export a spreadsheet CSV or the complete JSON plan from the Export menu. The menu closes when you choose a format, click elsewhere, move focus outside it, or press Escape.

**Route planning workflow**

- New countries start from a weighted blend of up to three same-month comparison markets. Country-centroid distance and approximate distance to Abu Dhabi determine the fixed weights. This is a geographic starting heuristic, not evidence of passenger demand, visa access, income, or travel purpose. Details shows every country and weight. A manual single-country option remains available.
- Travel-purpose labels (mixed, holiday, business, family) have no measured numerical presets. Users can explicitly apply hotel-use and stay assumptions; historical baselines remain unchanged.
- Compare isolates the additional-flight effect by comparing each option with zero extra flights under the same assumptions. It shows route alternatives, twelve months, nights per 1,000 added seats, illustrative launch sizes, bounded stress trials, and whole-weekly-flight capacity targets. Equal assumptions must produce equal per-seat yields. These comparisons do not establish profitability or independent passenger demand.
- Decision notes export as text, including both options' inputs and incremental results, uncertainty checks, and next steps. CSV/JSON exports retain the main plan inputs and outputs.

**Evidence and reproduction**

**Presentation walkthrough:** choose New route, enter Greece and confirm. Set the month and proposed weekly flights. Open Details to show the comparison countries and country-reference map. Return to Focus and choose **Finish with a planning decision**: read the estimated extra guest nights, the assumption with the largest effect in the stated trials, and the airline/hotel checks. Export the decision note to retain the exact assumptions. Guest nights count people staying overnight, so confirm guests per room before translating the estimate into rooms or staffing.

All four app pages stay visible on smaller presentation screens. Chat confirms values read back from the applied plan; requests outside the controls' limits are rejected without changing the plan. Map markers show country reference locations and Abu Dhabi city, not specific airports.

Country-specific hotel-conversion rates cannot be identified reliably from departure-country flights and passport-nationality hotel aggregates. The optional training-season rates in Details use only 2022–2024 calibration data. On the seven 2025 check months, seasonal rates have 6.91% weighted error versus 6.56% for a constant training-only rate; no accuracy improvement is claimed. Each month-of-year rate has three observations, and the held-out period does not test August–December.

Run `python3 src/build_conversion_evidence.py` to reproduce calibration from the supplied workbooks without editing them. Run `node tests/conversion_evidence.mjs --from-source` for the source-based check. `node tests/route_planning.mjs` tests geographic profiles and leave-one-market-out reconstruction of flight assumptions; that check does not validate new-route hotel demand. `node tests/decision_tools.mjs`, `node tests/plans.mjs`, and `node tests/exports.mjs` check planning calculations, restoration and exported values.

**Proposal actions, help and feedback**

**Proposal workflow:** The new **Actions** view keeps versions, comments, planning chat, decisions, assigned follow-ups and stakeholder drafts together for each country/month. Red means overdue, amber means missing/pending/stale evidence, and green means a user recorded evidence for the exact current assumptions. Green is not approval or a forecast-accuracy claim. Changing assumptions makes earlier evidence require review. Save a version to retain a milestone and load it later.

The labelled **Actions** button opens a drawer from the right, with separate **Priority actions** and **Communications** tabs. Its badge counts pending checks; overdue checks give the badge a red accent. The drawer closes with its close button, Escape or a click outside it, preserving unfinished work. **Review** opens the selected check in **Follow-ups**, where it can become a task or discussion. **Stakeholder update** prepares a draft for that check using the current numbers and evidence status. Internal discussion is a local record, not a live shared channel.

All proposal records stay in this browser; they are not a shared team database. Owner labels do not notify anyone, and overdue checks are evaluated while the app is used. Drafts can be edited, copied or downloaded; nothing is sent. Download local history to retain a record. Browser storage limits or failures are reported visibly. Demonstration test records, if present, are labelled as tests and are not verified airline or hotel evidence.

**Guide me** offers searchable help, five walkthroughs, tooltips, the current data dictionary, usage/data guidance and the calculation audit when it is available. The audit was updated on 1 November 2026 to match the current engine, including new-route blending, events, comparisons, baseline isolation and validation limits. Its source hashes identify the app version reviewed; future calculation changes require another audit update. The guidance is not an official organisation policy. Feedback stays local. Feature counts are opt-in and contain fixed event names and counts only, never question text or proposal values.

Chat handles clear numeric requests locally and confirms applied values. Optional Gemini use requires the per-session consent checkbox: an open-ended question then sends the question, recent conversation, current plan and built-in check-status summary to Google. Local comments, evidence notes and custom task text are excluded. AI answers are labelled and cannot execute changes or send messages. Plan changes during an AI request make its old explanation unusable.

Run `node tests/planning_chat.mjs`, `node tests/proposal_workspace.mjs`, and `node tests/guided_help.mjs` for the workflow regression checks. Local browser storage is suitable for a demonstration; workplace team use would need a shared backend, sign-in, permissions, backups and approved data-handling policies.

**Optional Gemini chat (local demo)**

1. Copy `.env.example` to a new file named `.env` in the Air2Stay project folder.
2. Open `.env` and add your Google AI Studio key after `GEMINI_API_KEY=`.
3. Restart Air2Stay. The key stays on this computer and is not included in Git.

The built-in planner still works without a Gemini key. Gemini is used for open-ended questions; Air2Stay calculates the displayed scenario results itself. The local Gemini bridge listens only on this computer.

**Standalone prototype (without the Streamlit wrapper)**
```bash
python -m http.server 8765 --directory prototype
```
Then open http://localhost:8765.

## 📊 Project Structure

```
Air2Stay_Project/
├── ppt/
│   ├── Air2Stay.pdf          # 👈 Executive PDF presentation & report
│   └── Air2Stay.pptx         # PowerPoint version
├── prototype/                # Web interface (HTML/CSS/JavaScript)
│   ├── index.html           # Application shell
│   ├── styles.css           # Design system
│   ├── app.mjs              # UI controller
│   ├── engine.mjs           # Scenario engine
│   └── data/                # Embedded JSON outputs
├── outputs/                  # Generated model artifacts & reports
├── app.py                    # Python backend application
├── src/                      # Python model builder
│   └── build_model.py        # Main data processing pipeline
└── package.json              # Project package configuration
```

## 🎨 Design Highlights

The interface features:
- **Color System**: Navy surfaces with gold and orange accents; labelled red, amber and green action statuses
- **Responsive Grid**: 4-column on desktop, 2-column on tablet, stacked on mobile
- **Accessible Charts**: SVG lines, labeled bars, searchable tables
- **Local planner**: Calculations run locally. Open-ended assistant questions use Google Gemini only when a key is configured and the user enables it for the session. Exports contain assumptions and any edited visitor mix.

---

**Last Updated:** November 2026

**Status:** Competition prototype
**License:** Proprietary to DCT
