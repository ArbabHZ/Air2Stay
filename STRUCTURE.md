# Air2Stay Codebase Architecture & Directory Structure

## Overview
Air2Stay is a flight-to-hotel demand forecasting system developed for the Abu Dhabi Department of Culture and Tourism (DCT). It bridges flight capacity variations to hotel occupancy projections across 45+ guest nationalities.

---

## Directory & File Structure

```
Air2Stay/
├── .venv/                     # Python virtual environment
├── prototype/                 # Web application frontend (HTML/CSS/JS)
│   ├── index.html             # Main HTML application layout & components
│   ├── styles.css             # UI design system and styling rules
│   ├── app.mjs                # UI controller, event listeners, and DOM management
│   ├── engine.mjs             # Standalone scenario calculation and forecasting engine
│   └── data/                  # Embedded assets
│       ├── admin0-countries.svg # Interactive world map SVG vector asset
│       ├── scenario_data.json   # Model baselines, route data, and bridge parameters
│       └── country_locations.json # Country labels, map points, and bounds for new routes
├── src/                       # Backend data processing and modeling engine
│   └── build_model.py         # Data validation, route baseline calculation, and JSON pipeline
├── outputs/                   # Generated data artifacts & reports
│   └── model/                 # Validation reports, prediction CSVs, matrix files
├── ppt/                       # Presentation materials
│   ├── Air2Stay.pdf
│   └── Air2Stay.pptx
├── app.py                     # Streamlit web wrapper for standalone prototype
├── package.json               # Node.js project metadata & dev scripts
├── requirements.txt           # Python dependencies (Streamlit, Pandas, OpenPyXL, etc.)
├── run_prototype.ps1          # Windows PowerShell automated launcher
├── README.md                  # Main project overview and setup documentation
├── flight_data.xlsx                 # Excel input: Historical flight capacity data
├── data domestic_train.xlsx         # Excel input: Domestic hotel training dataset
├── data domestic_test.xlsx          # Excel input: Domestic hotel testing dataset
├── data international_train.xlsx    # Excel input: International hotel training dataset
└── data international_test.xlsx    # Excel input: International hotel testing dataset
```

---

## Key Subdirectory Explanations

### 1. `src/` (Data Processing & Model Pipeline)
- **`build_model.py`**: Reads raw Excel flight and hotel datasets, executes route baselining, calculates nationality bridge matrices, performs backtesting, and generates `prototype/data/scenario_data.json`.

### 2. `prototype/` (Web Simulator)
- **`index.html`**: Structured single-page app containing Scenario Studio, Country Bridge, Model Trust, and Plain Language documentation views.
- **`styles.css`**: Design system featuring Navy (#0f172a) and Teal (#0d9488) accents with responsive CSS grids.
- **`engine.mjs`**: Pure mathematical forecasting engine computing hotel arrivals, guest nights, room demand, and country distribution.
- **`app.mjs`**: Controller wiring input sliders, dropdowns, chart updates, and map visualizations to `engine.mjs`.

### 3. `outputs/` (Model Output Artifacts)
- Contains detailed CSV matrices, model metrics (`model_report.md` / `model_report.json`), and validated prediction outputs.

### 4. `app.py` (Streamlit Host Container)
- Bundles the frontend assets (`index.html`, `styles.css`, `engine.mjs`, `app.mjs`, `scenario_data.json`, and `country_locations.json`) into an inlined self-contained Streamlit application.
