# Air2Stay Scenario Copilot

A sophisticated flight-to-hotel demand forecasting system for the Abu Dhabi Department of Culture and Tourism (DCT). Air2Stay combines historical flight data with hotel occupancy patterns to enable strategic scenario planning and market analysis.

![Status](https://img.shields.io/badge/status-production-green) ![Python](https://img.shields.io/badge/python-3.8+-blue) ![License](https://img.shields.io/badge/license-proprietary-red)

## 🎯 Overview

Air2Stay predicts how changes in flight capacity and routing impact hotel demand across 45+ nationalities. The system supports:

- **Scenario Planning**: Adjust flight frequency, capacity, load factors, and guest behavior
- **Country Bridge**: Map departure countries to guest nationalities with data-driven confidence
- **Transparent Calculation**: Every assumption is visible and adjustable
- **Historical Validation**: Closed-book testing against 7 months of actual hotel data
- **Sensitivity Analysis**: Identify which variables drive outcomes most

## 🚀 Quick Start

### Prerequisites
- Python 3.8+ with pip
- Node.js (for the web interface)
- Five required Excel files (see below)

### Installation & Running

**Option 1: Windows (Easiest)**
```bash
# Place these Excel files in the project root:
# - flight_data.xlsx
# - domestic_train.xlsx
# - domestic_test.xlsx
# - international_train.xlsx
# - international_test.xlsx

# Then double-click: START_AIR2STAY.bat
```

**Option 2: Manual Setup**
```bash
# 1. Install Python dependencies
python -m pip install -r requirements.txt

# 2. Place Excel files in project root (not in /data folder)

# 3. Rebuild the model
python rebuild_model.ps1          # Windows PowerShell
python -m src.build_model          # macOS/Linux

# 4. Start the web server
# (The build process does this automatically)
# Open browser to: http://localhost:3000
```

### First Run Checks
```bash
# Windows:
RUN_CHECKS.bat

# macOS/Linux:
pytest tests/
```

## 📊 Project Structure

```
Air2Stay_Project 2/
├── src/                      # Python model builder
│   └── build_model.py        # Main data processing pipeline
├── prototype/                # Web interface (HTML/CSS/JavaScript)
│   ├── index.html           # Application shell
│   ├── styles.css           # Design system
│   ├── app.mjs              # UI controller
│   ├── engine.mjs           # Scenario engine
│   └── data/                # Embedded JSON outputs
├── tests/                    # Validation tests
│   └── test_model_outputs.py # Model accuracy tests
├── outputs/                  # Generated model artifacts
├── deliverables/            # Standalone HTML export
├── docs/                     # Reference documentation
├── tools/                    # Packaging utilities
├── requirements.txt          # Python dependencies
└── data/                     # Input Excel files location
```

## 🔄 Workflow

### 1. Model Building
The Python pipeline processes flight and hotel data:
```
Raw Excel Files → Data Validation → Route Baseline Calculation 
→ Country Bridge Estimation → Validation Testing → JSON Export
```

**Key outputs:**
- `scenario_data.json` - Route baselines and bridge weights
- Validation metrics (WMAPE, daily stay error)

### 2. Web Interface
The prototype provides four interactive views:

| View | Purpose |
|------|---------|
| **Scenario Studio** | Adjust parameters and see real-time impacts |
| **Country Bridge** | Edit nationality distributions with confidence scores |
| **Model Trust** | Review validation results and historical accuracy |
| **Plain Language** | Glossary and known data limits |

### 3. Data Flow
```
Scenario Parameters (UI)
        ↓
Scenario Engine (JavaScript)
        ↓
Route Baselines × Adjustment Factors
        ↓
Hotel Check-ins & Guest Nights
        ↓
Country Bridge Distribution
        ↓
Nationality-Level Forecasts
```

## 📋 Data Requirements

### Input Files (Required in project root)
- **flight_data.xlsx** - Historical flights by country and month
- **domestic_train.xlsx** - Training hotel data (domestic guests)
- **domestic_test.xlsx** - Test hotel data (domestic guests)
- **international_train.xlsx** - Training hotel data (international guests)
- **international_test.xlsx** - Test hotel data (international guests)

### Data Constraints
- Monthly grain (due to 2022 data limitations)
- Departure country ≠ Guest nationality (bridged separately)
- No purpose-of-travel segmentation
- No aircraft type, room inventory, or event data

## 🔍 Key Metrics

### Scenario Outputs
- **Hotel Check-ins** - Total expected new arrivals
- **Guest Nights** - Sum across all guests and days
- **Room Nights Demanded** - Check-ins × Average Stay
- **Nationality Distribution** - 45-country breakdown

### Validation Metrics
- **WMAPE** (Weighted Mean Absolute Percentage Error)
  - 7% = 7 check-ins error per 100 actual (approximate)
  - Measures prediction accuracy against supplied hotel data
- **Daily Stay Error** - Separate test for occupancy prediction

### Confidence Scoring
- **High**: 3+ historical observations for route + month
- **Medium**: 1–2 observations (interpolation used)
- **Low**: No historical data (fallback assumptions used)

## 🎨 Design Highlights

The interface features:
- **Color System**: Navy (primary) + Teal (accent) + Copper (warning)
- **Responsive Grid**: 4-column on desktop, 2-column on tablet, stacked on mobile
- **Accessible Charts**: SVG lines, labeled bars, searchable tables
- **Semantic HTML**: Main sections, nav tabs, labeled forms
- **Dark Header**: High contrast for navigation
- **Sandbox Mode**: No external API calls (local-only processing)

## 🧪 Testing

```bash
# Run all Python tests
pytest tests/

# Run specific test
pytest tests/test_model_outputs.py -v

# JavaScript lint check (if Node.js available)
npm run lint  # (if eslint configured)
```

## 🔐 Security & Privacy

✅ **Local Processing Only**
- All data stays on the user's machine
- No external API calls
- No telemetry or analytics

✅ **Data Protection**
- Standalone export contains derived aggregates only, not row-level data
- Country Bridge shows patterns, not individual travelers
- Original competition data marked proprietary

⚠️ **Usage Restrictions**
- Do not publish original input files without DCT approval
- Do not share planner overrides without named data owner

## 📖 Documentation

- **START_HERE.txt** - Windows quick-start guide
- **DATA_FILES_NEEDED.txt** - File placement instructions
- **docs/** - Technical guides and data dictionary

## 🛠️ Development

### Adding a New Scenario Parameter
1. Add input field to `prototype/index.html`
2. Add form handler in `prototype/app.mjs`
3. Update calculation chain in `prototype/engine.mjs`
4. Add validation test in `tests/`

### Modifying the Model
1. Edit `src/build_model.py`
2. Run: `python -m src.build_model`
3. Verify outputs in `outputs/` folder
4. Run tests: `pytest tests/`

### Deploying Standalone Export
```bash
python tools/package_standalone.py
# → generates deliverables/index.html
```

## 📞 Support

**Before running:**
- Verify Python 3.8+ is installed: `python --version`
- Verify Node.js is installed: `node --version`
- Ensure five Excel files are in project root
- Check that ports 3000+ are available

**If Excel files are missing:**
```
Error: Could not load scenario data

Solution: Place these files in the project root (not /data):
- flight_data.xlsx
- domestic_train.xlsx
- domestic_test.xlsx
- international_train.xlsx
- international_test.xlsx
```

**If port 3000 is in use:**
The batch file will auto-increment to 3001, 3002, etc.

## 📝 Version History

- **v2.0** - Transparent calculation, sensitivity analysis, standalone export
- **v1.0** - Initial release with basic scenario planning

## 🙏 Credits

Developed for the Abu Dhabi Department of Culture and Tourism (DCT).

**Data Sources:**
- Abu Dhabi flight data (confidential)
- Abu Dhabi hotel occupancy statistics (confidential)
- Supplied training/test datasets (2022–2025)

---

**Last Updated:** September 2025  
**Status:** Production Ready  
**License:** Proprietary to DCT
