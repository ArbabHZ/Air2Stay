from __future__ import annotations
 
import json
import math
import sys
from pathlib import Path
 
import numpy as np
import pandas as pd
 
 
sys.stdout.reconfigure(encoding="utf-8")
ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "outputs" / "model"
WEB_DATA_DIR = ROOT / "prototype" / "data"


def resolve_input_path(name: str) -> Path:
    """Resolve inputs from either the documented root or legacy data names."""
    candidates = [
        ROOT / name,
        ROOT / "data" / name,
        ROOT / f"data {name}",
    ]
    for path in candidates:
        if path.is_file():
            return path
    searched = ", ".join(str(path) for path in candidates)
    raise FileNotFoundError(f"Could not find {name}. Searched: {searched}")


def read_excel(name: str) -> pd.DataFrame:
    frame = pd.read_excel(resolve_input_path(name), sheet_name="Export")
    frame["Date"] = pd.to_datetime(frame["Date"])
    return frame
 
 
def wmape(actual: np.ndarray, predicted: np.ndarray) -> float:
    actual = np.asarray(actual, dtype=float)
    predicted = np.asarray(predicted, dtype=float)
    denominator = np.abs(actual).sum()
    return float(np.abs(actual - predicted).sum() / denominator) if denominator else float("nan")
 
 
def wmape_components(actual: np.ndarray, predicted: np.ndarray) -> dict[str, float]:
    """Return the two totals used in WMAPE so the score is fully auditable."""
    actual = np.asarray(actual, dtype=float)
    predicted = np.asarray(predicted, dtype=float)
    return {
        "absolute_error_sum": float(np.abs(actual - predicted).sum()),
        "actual_sum": float(np.abs(actual).sum()),
    }
 
 
def fit_ridge(x: np.ndarray, y: np.ndarray, alpha: float = 8.0) -> dict:
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    mean = x.mean(axis=0)
    scale = x.std(axis=0)
    scale[scale < 1e-9] = 1.0
    z = (x - mean) / scale
    design = np.column_stack([np.ones(len(z)), z])
    penalty = np.eye(design.shape[1]) * alpha
    penalty[0, 0] = 0.0
    beta = np.linalg.solve(design.T @ design + penalty, design.T @ y)
    return {"mean": mean, "scale": scale, "beta": beta}
 
 
def predict_ridge(model: dict, x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=float)
    z = (x - model["mean"]) / model["scale"]
    design = np.column_stack([np.ones(len(z)), z])
    return design @ model["beta"]
 
 
def calendar_features(dates: pd.Series | pd.DatetimeIndex) -> np.ndarray:
    dates = pd.DatetimeIndex(dates)
    dow = dates.dayofweek.to_numpy()
    doy = dates.dayofyear.to_numpy()
    month = dates.month.to_numpy()
    return np.column_stack(
        [
            np.sin(2 * np.pi * dow / 7),
            np.cos(2 * np.pi * dow / 7),
            np.sin(2 * np.pi * doy / 365.25),
            np.cos(2 * np.pi * doy / 365.25),
            np.sin(2 * np.pi * month / 12),
            np.cos(2 * np.pi * month / 12),
        ]
    )
 
 
def stay_features(frame: pd.DataFrame) -> np.ndarray:
    arrivals = frame["New Arrivals"].astype(float).fillna(0.0)
    same_day = frame["Same-Day Guests"].astype(float).fillna(0.0)
    parts = [arrivals.to_numpy(), same_day.to_numpy()]
    for lag in (1, 2, 3, 4, 5, 6, 7, 14, 21, 28):
        parts.append(arrivals.shift(lag).fillna(0.0).to_numpy())
    parts.extend(
        [
            arrivals.rolling(7, min_periods=1).mean().to_numpy(),
            arrivals.rolling(14, min_periods=1).mean().to_numpy(),
            arrivals.rolling(28, min_periods=1).mean().to_numpy(),
        ]
    )
    numeric = np.column_stack(parts)
    return np.column_stack([numeric, calendar_features(frame.index)])
 
 
def build_complete_series(
    train_group: pd.DataFrame,
    test_group: pd.DataFrame,
    key: str | None = None,
) -> tuple[pd.DataFrame, pd.Index]:
    start = min(train_group["Date"].min(), test_group["Date"].min())
    end = max(train_group["Date"].max(), test_group["Date"].max())
    index = pd.date_range(start, end, freq="D")
    columns = ["New Arrivals", "Same-Day Guests"]
    combined = pd.concat(
        [train_group[["Date", *columns]], test_group[["Date", *columns]]],
        ignore_index=True,
    ).drop_duplicates("Date", keep="last")
    combined = combined.set_index("Date").reindex(index)
    combined[columns] = combined[columns].fillna(0.0)
    return combined, pd.Index(test_group["Date"])
 
 
def fit_stay_models(
    train: pd.DataFrame,
    test: pd.DataFrame,
    group_column: str | None,
    validation_start: str = "2025-05-01",
) -> tuple[pd.DataFrame, dict]:
    if group_column:
        groups = sorted(test[group_column].dropna().unique())
    else:
        groups = ["Domestic"]
 
    validation_actual: list[float] = []
    validation_predicted: list[float] = []
    validation_dates: list[pd.Timestamp] = []
    predictions: list[pd.DataFrame] = []
    per_group_metrics: dict[str, float] = {}
    training_row_count = 0
 
    for group in groups:
        if group_column:
            train_group = train[train[group_column] == group].copy()
            test_group = test[test[group_column] == group].copy()
        else:
            train_group = train.copy()
            test_group = test.copy()
 
        series, test_dates = build_complete_series(train_group, test_group, group_column)
        features = stay_features(series)
        date_index = series.index
 
        target = train_group.set_index("Date")["Guests"].reindex(date_index)
        observed = target.notna().to_numpy()
        validation = observed & (date_index >= pd.Timestamp(validation_start))
        training = observed & (date_index < pd.Timestamp(validation_start))
        if training.sum() < 60 or validation.sum() < 10:
            training = observed
            validation = np.zeros(len(date_index), dtype=bool)
 
        validation_model = fit_ridge(features[training], target.to_numpy()[training], alpha=12.0)
        training_row_count += int(training.sum())
        if validation.any():
            val_prediction = predict_ridge(validation_model, features[validation])
            val_arrivals = series["New Arrivals"].to_numpy()[validation]
            val_prediction = np.maximum(val_prediction, val_arrivals)
            val_prediction = np.maximum(val_prediction, 0.0)
            actual = target.to_numpy()[validation]
            validation_actual.extend(actual.tolist())
            validation_predicted.extend(val_prediction.tolist())
            validation_dates.extend(date_index[validation].tolist())
            per_group_metrics[str(group)] = wmape(actual, val_prediction)
 
        final_model = fit_ridge(features[observed], target.to_numpy()[observed], alpha=12.0)
        test_mask = date_index.isin(test_dates)
        predicted = predict_ridge(final_model, features[test_mask])
        predicted = np.maximum(predicted, series["New Arrivals"].to_numpy()[test_mask])
        predicted = np.maximum(predicted, 0.0)
        result = pd.DataFrame({"Date": date_index[test_mask], "Predicted Guests": predicted})
        if group_column:
            result[group_column] = group
        predictions.append(result)
 
    prediction_frame = pd.concat(predictions, ignore_index=True)
    sort_columns = ["Date", group_column] if group_column else ["Date"]
    prediction_frame = prediction_frame.sort_values([c for c in sort_columns if c])
    observed_rows = training_row_count + len(validation_actual)
    metrics = {
        "wmape": wmape(np.array(validation_actual), np.array(validation_predicted)),
        "source_rows": int(len(train)),
        "training_rows": training_row_count,
        "validation_rows": len(validation_actual),
        "training_share": training_row_count / observed_rows if observed_rows else float("nan"),
        "validation_share": len(validation_actual) / observed_rows if observed_rows else float("nan"),
        "validation_period": (
            f"{min(validation_dates).date()} to {max(validation_dates).date()}"
            if validation_dates else "not available"
        ),
        "per_group_wmape": per_group_metrics,
    }
    return prediction_frame, metrics
 
 
def aggregate_flights(flight: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    flight = flight.copy()
    flight["Month"] = flight["Date"].dt.to_period("M")
    flight["Month Number"] = flight["Date"].dt.month
    flight["Country"] = flight["Departure Country Name"].str.upper()
 
    monthly = (
        flight.groupby(["Country", "Month"], as_index=False)
        .agg(
            Total_Seats=("Total Seats", "sum"),
            Total_PAX=("Total PAX", "sum"),
            Total_P2P=("Total P2P", "sum"),
            Total_Transfer=("Total Transfer", "sum"),
            Total_Transit=("Total Transit", "sum"),
        )
    )
    monthly["Month Number"] = monthly["Month"].dt.month
 
    # In the daily flight extract each route-day carries its fraction of a weekly
    # service. Summing those fractions across a month recovers weekly frequency.
    route_frequency = (
        flight.groupby(["Country", "Month"], as_index=False)["Average Weekly Frequency"]
        .sum(min_count=1)
    )
    monthly = monthly.merge(route_frequency, on=["Country", "Month"], how="left")
    # Keep raw source counts intact for audit. Cap impossible
    # occupancy in the planning chain and rebase P2P share on the same capped
    # passenger denominator, preserving recorded P2P whenever capacity permits.
    monthly["Planning PAX"] = monthly["Total_PAX"].clip(lower=0).clip(upper=monthly["Total_Seats"])
    monthly["Planning P2P"] = monthly["Total_P2P"].clip(lower=0).clip(upper=monthly["Planning PAX"])
    monthly["Load Factor"] = monthly["Planning PAX"] / monthly["Total_Seats"].replace(0, np.nan)
    monthly["P2P Share"] = monthly["Planning P2P"] / monthly["Planning PAX"].replace(0, np.nan)
    monthly["Weeks"] = monthly["Month"].dt.days_in_month / 7.0
    monthly["Seats Per Flight"] = monthly["Total_Seats"] / (
        monthly["Average Weekly Frequency"] * monthly["Weeks"]
    ).replace(0, np.nan)
 
    seasonal = (
        monthly.groupby(["Country", "Month Number"], as_index=False)
        .agg(
            baseline_seats=("Total_Seats", "mean"),
            total_pax=("Planning PAX", "sum"),
            total_p2p=("Planning P2P", "sum"),
            total_seats=("Total_Seats", "sum"),
            weekly_frequency=("Average Weekly Frequency", "mean"),
            seats_per_flight=("Seats Per Flight", "median"),
            years_observed=("Month", "nunique"),
        )
    )
    seasonal["load_factor"] = seasonal["total_pax"] / seasonal["total_seats"].replace(0, np.nan)
    seasonal["p2p_share"] = seasonal["total_p2p"] / seasonal["total_pax"].replace(0, np.nan)
    seasonal["seats_per_flight"] = seasonal["seats_per_flight"].fillna(220.0).clip(50, 450)
    seasonal["weekly_frequency"] = seasonal["weekly_frequency"].fillna(
        seasonal["baseline_seats"] / (seasonal["seats_per_flight"] * 4.345)
    )
    seasonal["load_factor"] = seasonal["load_factor"].clip(0.0, 1.0)
    seasonal["p2p_share"] = seasonal["p2p_share"].clip(0.05, 1.0)
    return monthly, seasonal
 
 
def aggregate_hotels(international: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    hotel = international.copy()
    hotel["Month"] = hotel["Date"].dt.to_period("M")
    hotel["Month Number"] = hotel["Date"].dt.month
    hotel["Country"] = hotel["Nationality"].str.upper()
    hotel["Same-Day Guests"] = hotel["Same-Day Guests"].fillna(0.0)
    monthly = (
        hotel.groupby(["Country", "Month"], as_index=False)
        .agg(Guests=("Guests", "sum"), New_Arrivals=("New Arrivals", "sum"), Same_Day=("Same-Day Guests", "sum"))
    )
    monthly["Month Number"] = monthly["Month"].dt.month
 
    global_los = float(monthly["Guests"].sum() / monthly["New_Arrivals"].sum())
    nationality_los = monthly.groupby("Country")[["Guests", "New_Arrivals"]].sum()
    nationality_los["nationality_los"] = nationality_los["Guests"] / nationality_los["New_Arrivals"].replace(0, np.nan)
    seasonal_los = monthly.groupby(["Country", "Month Number"])[["Guests", "New_Arrivals"]].sum()
    seasonal_los["raw_los"] = seasonal_los["Guests"] / seasonal_los["New_Arrivals"].replace(0, np.nan)
    seasonal_los = seasonal_los.reset_index().merge(
        nationality_los[["nationality_los"]].reset_index(), on="Country", how="left"
    )
    seasonal_los["average_stay"] = (
        0.7 * seasonal_los["raw_los"] + 0.3 * seasonal_los["nationality_los"]
    ).fillna(global_los).clip(1.0, 8.0)
 
    totals = hotel.groupby("Month")[["Guests", "New Arrivals", "Same-Day Guests"]].sum().reset_index()
    summary = {"global_average_stay": global_los}
    return monthly, seasonal_los, summary
 
 
def safe_corr(a: pd.Series, b: pd.Series) -> float:
    if a.std() < 1e-9 or b.std() < 1e-9:
        return 0.0
    value = a.corr(b)
    return float(value) if pd.notna(value) else 0.0
 
 
def build_bridge(flight_monthly: pd.DataFrame, hotel_monthly: pd.DataFrame) -> pd.DataFrame:
    common_months = sorted(set(flight_monthly["Month"]) & set(hotel_monthly["Month"]))
    origins = sorted(flight_monthly["Country"].unique())
    nationalities = sorted(hotel_monthly["Country"].unique())
    x_pivot = (
        flight_monthly[flight_monthly["Month"].isin(common_months)]
        .pivot_table(index="Month", columns="Country", values="Total_P2P", aggfunc="sum", fill_value=0)
        .reindex(common_months, fill_value=0)
    )
    y_pivot = (
        hotel_monthly[hotel_monthly["Month"].isin(common_months)]
        .pivot_table(index="Month", columns="Country", values="New_Arrivals", aggfunc="sum", fill_value=0)
        .reindex(common_months, fill_value=0)
    )
    average_share = y_pivot.mean(axis=0)
    average_share = average_share / average_share.sum()
 
    month_share = hotel_monthly.pivot_table(
        index="Month Number", columns="Country", values="New_Arrivals", aggfunc="mean", fill_value=0
    ).reindex(index=range(1, 13), columns=nationalities, fill_value=0)
    month_share = month_share.div(month_share.sum(axis=1), axis=0)
    overall_share = average_share.reindex(nationalities).replace(0, np.nan)
    seasonal_factor = month_share.div(overall_share, axis=1).replace([np.inf, -np.inf], np.nan).fillna(1.0).clip(0.35, 2.5)
 
    rows: list[dict] = []
    for origin in origins:
        x = np.log1p(x_pivot[origin].astype(float))
        scores: dict[str, float] = {}
        correlations: dict[str, dict[str, float]] = {}
        for nationality in nationalities:
            y = np.log1p(y_pivot[nationality].astype(float))
            level_corr = safe_corr(x, y)
            diff_corr = safe_corr(x.diff().fillna(0), y.diff().fillna(0))
            correlation = max(0.0, 0.7 * level_corr + 0.3 * diff_corr)
            correlations[nationality] = {
                "level": level_corr,
                "change": diff_corr,
                "combined": correlation,
            }
            score = float(average_share.get(nationality, 0.0)) * (0.35 + 2.0 * correlation**2)
            if nationality == origin:
                score *= 6.0
            scores[nationality] = max(score, 1e-9)
 
        for month_number in range(1, 13):
            adjusted = {
                nationality: scores[nationality] * float(seasonal_factor.loc[month_number, nationality]) ** 0.7
                for nationality in nationalities
            }
            total = sum(adjusted.values())
            for nationality in nationalities:
                rows.append(
                    {
                        "origin_country": origin,
                        "nationality": nationality,
                        "month": month_number,
                        "base_nationality_share": float(average_share.get(nationality, 0.0)),
                        "direct_match_multiplier": 6.0 if nationality == origin else 1.0,
                        "pre_season_score": scores[nationality],
                        "seasonal_factor": float(seasonal_factor.loc[month_number, nationality]),
                        "season_adjusted_score": adjusted[nationality],
                        "normalization_total": total,
                        "weight": adjusted[nationality] / total,
                        "relationship": "direct and inferred" if nationality == origin else "inferred",
                        "level_correlation": correlations[nationality]["level"],
                        "change_correlation": correlations[nationality]["change"],
                        "combined_correlation": correlations[nationality]["combined"],
                        # Retain the original column name for backward compatibility.
                        "correlation": correlations[nationality]["combined"],
                    }
                )
    return pd.DataFrame(rows)
 
 
def planning_chain(seats, load_factor, p2p_share, conversion_rate, average_stay=1.0):
    """Numerical contract shared with prototype/engine.mjs (no rounding)."""
    passengers = np.maximum(0.0, seats) * np.maximum(0.0, load_factor)
    p2p = passengers * np.maximum(0.0, p2p_share)
    checkins = p2p * np.maximum(0.0, conversion_rate)
    return {"seats": seats, "passengers": passengers, "p2p": p2p,
            "hotelCheckins": checkins, "guestNights": checkins * np.maximum(0.0, average_stay)}


def validate_flight_chain(
    flight_monthly: pd.DataFrame,
    hotel_monthly: pd.DataFrame,
) -> tuple[dict, pd.DataFrame]:
    flight_total = flight_monthly.groupby("Month").agg(
        Total_Seats=("Total_Seats", "sum"), Total_PAX=("Planning PAX", "sum"),
        Total_P2P=("Planning P2P", "sum"))
    hotel_total = hotel_monthly.groupby("Month")[["Guests", "New_Arrivals"]].sum()
    common = flight_total.join(hotel_total, how="inner").reset_index()
    common["Month Number"] = common["Month"].dt.month
    training = common["Month"] < pd.Period("2025-01", freq="M")
    validation = ~training
 
    global_capture = common.loc[training, "New_Arrivals"].sum() / common.loc[training, "Total_P2P"].sum()
    # The default live planner uses one training-only conversion rate, not the
    # seasonal or hybrid comparison model. Exercise the actual chain on each
    # held-out country-month, then score its sum against aggregate hotel data.
    live_rows = flight_monthly[flight_monthly["Month"].isin(common.loc[validation, "Month"])].copy()
    live_counts = planning_chain(
        live_rows["Total_Seats"].to_numpy(), live_rows["Load Factor"].to_numpy(),
        live_rows["P2P Share"].to_numpy(), global_capture,
    )
    live_rows["Live Prediction"] = live_counts["hotelCheckins"]
    live_prediction = common.loc[validation, "Month"].map(
        live_rows.groupby("Month")["Live Prediction"].sum()).to_numpy()
    capture_by_month = (
        common.loc[training].groupby("Month Number")[["New_Arrivals", "Total_P2P"]].sum()
    )
    capture_by_month["capture"] = capture_by_month["New_Arrivals"] / capture_by_month["Total_P2P"].replace(0, np.nan)
    capture_by_month["capture"] = 0.7 * capture_by_month["capture"] + 0.3 * global_capture
    parametric = common.loc[validation, "Total_P2P"].to_numpy() * common.loc[validation, "Month Number"].map(capture_by_month["capture"]).fillna(global_capture).to_numpy()
 
    def features(frame: pd.DataFrame) -> np.ndarray:
        month = frame["Month Number"].to_numpy()
        trend = np.arange(len(common))[frame.index.to_numpy()]
        return np.column_stack(
            [
                np.log1p(frame["Total_P2P"].to_numpy()),
                np.log1p(frame["Total_Seats"].to_numpy()),
                frame["Total_PAX"].to_numpy() / frame["Total_Seats"].replace(0, np.nan).to_numpy(),
                frame["Total_P2P"].to_numpy() / frame["Total_PAX"].replace(0, np.nan).to_numpy(),
                np.sin(2 * np.pi * month / 12),
                np.cos(2 * np.pi * month / 12),
                trend,
            ]
        )
 
    x = features(common).astype(float)
    x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)
    model = fit_ridge(x[training], np.log1p(common.loc[training, "New_Arrivals"].to_numpy()), alpha=4.0)
    ridge_prediction = np.expm1(predict_ridge(model, x[validation]))
    actual = common.loc[validation, "New_Arrivals"].to_numpy()
    ensemble = 0.55 * ridge_prediction + 0.45 * parametric
    ensemble = np.maximum(ensemble, 0.0)
 
    residual_ratio = actual / np.maximum(live_prediction, 1.0)
    low_multiplier = float(np.quantile(residual_ratio, 0.10))
    high_multiplier = float(np.quantile(residual_ratio, 0.90))
    validation_frame = common.loc[validation, ["Month", "New_Arrivals"]].copy()
    validation_frame["Predicted New Arrivals"] = ensemble
    validation_frame["Parametric Prediction"] = parametric
    validation_frame["Live Prediction"] = live_prediction
    validation_frame["Hybrid Absolute Error"] = np.abs(
        validation_frame["New_Arrivals"] - validation_frame["Predicted New Arrivals"]
    )
    validation_frame["Transparent Absolute Error"] = np.abs(
        validation_frame["New_Arrivals"] - validation_frame["Parametric Prediction"]
    )
    validation_frame["Live Absolute Error"] = np.abs(validation_frame["New_Arrivals"] - live_prediction)
    validation_frame["Month"] = validation_frame["Month"].astype(str)
    # Store and score full precision; rounding belongs only in display code.
    hybrid_values = validation_frame["Predicted New Arrivals"].to_numpy(dtype=float)
    seasonal_values = validation_frame["Parametric Prediction"].to_numpy(dtype=float)
    hybrid_components = wmape_components(actual, hybrid_values)
    transparent_components = wmape_components(actual, seasonal_values)
    live_components = wmape_components(actual, live_prediction)
    training_months = int(training.sum())
    validation_months = int(validation.sum())
    total_months = training_months + validation_months
    metrics = {
        "training_period": f"{common.loc[training, 'Month'].min()} to {common.loc[training, 'Month'].max()}",
        "validation_period": f"{validation_frame['Month'].min()} to {validation_frame['Month'].max()}",
        "training_months": training_months,
        "validation_months": validation_months,
        "total_months": total_months,
        "training_share": training_months / total_months,
        "validation_share": validation_months / total_months,
        "flight_to_checkins_wmape": wmape(actual, hybrid_values),
        "transparent_chain_wmape": wmape(actual, seasonal_values),
        "live_chain_wmape": wmape(actual, live_prediction),
        "hybrid_absolute_error_sum": hybrid_components["absolute_error_sum"],
        "transparent_absolute_error_sum": transparent_components["absolute_error_sum"],
        "live_absolute_error_sum": live_components["absolute_error_sum"],
        "validation_actual_sum": hybrid_components["actual_sum"],
        "global_capture_rate": float(global_capture),
        "weighted_load_factor": float(flight_monthly.loc[flight_monthly["Month"].isin(common.loc[training, "Month"]), "Planning PAX"].sum() / common.loc[training, "Total_Seats"].sum()),
        "p2p_share": float(common.loc[training, "Total_P2P"].sum() / flight_monthly.loc[flight_monthly["Month"].isin(common.loc[training, "Month"]), "Planning PAX"].sum()),
        "conversion_training_only": True,
        "uncertainty_method": "Live default chain residual ratios on the seven check months; descriptive bounds, not independently tested coverage",
        "uncertainty_low_multiplier": max(0.5, low_multiplier),
        "uncertainty_high_multiplier": min(1.8, high_multiplier),
    }
    return metrics, validation_frame
 
 
def scenario_payload(
    route_seasonal: pd.DataFrame,
    bridge: pd.DataFrame,
    seasonal_los: pd.DataFrame,
    flight_metrics: dict,
    stay_metrics: dict,
    flight_validation: pd.DataFrame,
) -> dict:
    routes = []
    for _, row in route_seasonal.iterrows():
        routes.append(
            {
                "origin": row["Country"].title(),
                "originKey": row["Country"],
                "month": int(row["Month Number"]),
                "baselineSeats": float(row["baseline_seats"]),
                "weeklyFrequency": float(row["weekly_frequency"]),
                "seatsPerFlight": float(row["seats_per_flight"]),
                "loadFactor": float(row["load_factor"]),
                "p2pShare": float(row["p2p_share"]),
                "yearsObserved": int(row["years_observed"]),
            }
        )
 
    los_lookup = {
        (row["Country"], int(row["Month Number"])): float(row["average_stay"])
        for _, row in seasonal_los.iterrows()
    }
    bridge_nested: dict[str, dict[str, list[dict]]] = {}
    for (origin, month), group in bridge.groupby(["origin_country", "month"]):
        top = group.sort_values("weight", ascending=False)
        bridge_nested.setdefault(origin, {})[str(int(month))] = [
            {
                "nationality": row["nationality"].title(),
                "nationalityKey": row["nationality"],
                "weight": float(row["weight"]),
                "averageStay": los_lookup.get((row["nationality"], int(month)), 3.6),
                "relationship": row["relationship"],
            }
            for _, row in top.iterrows()
        ]
 
    fallback_nested: dict[str, list[dict]] = {}
    for month, group in bridge.groupby("month"):
        fallback = group.groupby("nationality", as_index=False)["weight"].mean()
        fallback["weight"] = fallback["weight"] / fallback["weight"].sum()
        fallback = fallback.sort_values("weight", ascending=False)
        fallback_nested[str(int(month))] = [
            {
                "nationality": row["nationality"].title(),
                "nationalityKey": row["nationality"],
                "weight": float(row["weight"]),
                "averageStay": los_lookup.get((row["nationality"], int(month)), 3.6),
                "relationship": "fallback",
            }
            for _, row in fallback.iterrows()
        ]
 
    months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
    return {
        "product": "Air2Stay Scenario Copilot",
        "months": months,
        "routes": routes,
        "bridge": bridge_nested,
        "fallbackBridge": fallback_nested,
        "validation": [
            {
                "month": row["Month"],
                "actual": int(row["New_Arrivals"]),
                "predicted": float(row["Predicted New Arrivals"]),
                "transparent": float(row["Live Prediction"]),
                "seasonal": float(row["Parametric Prediction"]),
            }
            for _, row in flight_validation.iterrows()
        ],
        "defaults": {
            "captureRate": float(flight_metrics["global_capture_rate"]),
            "loadFactor": float(flight_metrics["weighted_load_factor"]),
            "p2pShare": float(flight_metrics["p2p_share"]),
            "conversionTrainingPeriod": flight_metrics["training_period"],
            "averageStay": 3.6,
            "uncertaintyLow": float(flight_metrics["uncertainty_low_multiplier"]),
            "uncertaintyHigh": float(flight_metrics["uncertainty_high_multiplier"]),
        },
        "metrics": {
            "flightToCheckinsWmape": float(flight_metrics["flight_to_checkins_wmape"]),
            "transparentChainWmape": float(flight_metrics["live_chain_wmape"]),
            "liveChainWmape": float(flight_metrics["live_chain_wmape"]),
            "seasonalChainWmape": float(flight_metrics["transparent_chain_wmape"]),
            "stayModelWmape": float(stay_metrics["wmape"]),
            "flightTrainingPeriod": flight_metrics["training_period"],
            "validationPeriod": flight_metrics["validation_period"],
            "trainingMonths": flight_metrics["training_months"],
            "validationMonths": flight_metrics["validation_months"],
            "trainingShare": float(flight_metrics["training_share"]),
            "validationShare": float(flight_metrics["validation_share"]),
            "hybridAbsoluteErrorSum": float(flight_metrics["hybrid_absolute_error_sum"]),
            "transparentAbsoluteErrorSum": float(flight_metrics["live_absolute_error_sum"]),
            "seasonalAbsoluteErrorSum": float(flight_metrics["transparent_absolute_error_sum"]),
            "validationActualSum": float(flight_metrics["validation_actual_sum"]),
            "stayValidationPeriod": stay_metrics["validation_period"],
            "stayTrainingRows": stay_metrics["training_rows"],
            "stayValidationRows": stay_metrics["validation_rows"],
            "stayTrainingShare": float(stay_metrics["training_share"]),
            "stayValidationShare": float(stay_metrics["validation_share"]),
        },
        "glossary": {
            "Calibration": "Using history to set sensible starting values for the simulator's dials.",
            "P2P passenger": "A point-to-point passenger whose airport journey ends in Abu Dhabi. This does not mean procure-to-pay here.",
            "Load factor": "The share of offered seats that passengers fill. 160 passengers on 200 seats means an 80% load factor.",
            "P10 / P50 / P90": "Three planning lanes: cautious low, central, and higher. P50 does not mean 50% accurate or a half-and-half chance. With only seven validation months, P10 and P90 are rough history-based bounds, not guaranteed probabilities.",
            "WMAPE": "Weighted Mean Absolute Percentage Error. Add the sizes of all prediction mistakes, then divide by the total actual result. Lower is better.",
            "Country bridge": "A transparent estimate of how the already-calculated hotel demand may be divided among guest nationalities. It does not add or remove total demand.",
            "Data support": "A rule about historical coverage, not a statistical confidence interval. High means the selected departure country and month have at least three historical observations; medium means one or two; low means no route history and fallback assumptions are used.",
        },
    }
 
 
def write_model_report(metrics: dict, international_metrics: dict, domestic_metrics: dict) -> None:
    report = {
        "model_version": "1.0.0",
        "generated_from": {
            "flight": "flight_data.xlsx",
            "international_train": "data international_train.xlsx",
            "international_test": "data international_test.xlsx",
            "domestic_train": "data domestic_train.xlsx",
            "domestic_test": "data domestic_test.xlsx",
        },
        "flight_chain": metrics,
        "international_stay_model": international_metrics,
        "domestic_stay_model": domestic_metrics,
        "plain_language": {
            "flight_chain": "This score tests whether flight passengers can estimate international hotel check-ins.",
            "stay_model": "This score tests whether check-ins and recent arrival patterns can estimate daily guests in hotels.",
            "wmape": "WMAPE means Weighted Mean Absolute Percentage Error: total absolute prediction mistakes divided by the total actual value. Lower is better.",
        },
        "source_lineage": {
            "flight_scenario_and_chain": {
                "file": "flight_data.xlsx",
                "sheet": "Export",
                "excel_rows": "2:117609",
                "fields": ["Date", "Departure Country Name", "Average Weekly Frequency", "Load Factor", "Total P2P", "Total PAX", "Total Seats", "Total Transfer", "Total Transit"],
            },
            "hotel_actuals_bridge_and_stay": {
                "file": "data international_train.xlsx",
                "sheet": "Export",
                "excel_rows": "2:58623",
                "fields": ["Date", "Guests", "New Arrivals", "Same-Day Guests", "Nationality", "Residence (groups)"],
            },
            "international_future_prediction_inputs": {
                "file": "data international_test.xlsx",
                "sheet": "Export",
                "excel_rows": "2:9203",
                "fields": ["Date", "New Arrivals", "Same-Day Guests", "Nationality", "Residence (groups)"],
            },
            "domestic_training": {
                "file": "data domestic_train.xlsx",
                "sheet": "Export",
                "excel_rows": "2:1309",
                "fields": ["Date", "Guests", "New Arrivals", "Same-Day Guests", "Residence (groups)"],
            },
            "domestic_future_prediction_inputs": {
                "file": "data domestic_test.xlsx",
                "sheet": "Export",
                "excel_rows": "2:213",
                "fields": ["Date", "New Arrivals", "Same-Day Guests", "Residence (groups)"],
            },
        },
        "limitations": [
            "Flight country means departure country, while hotel country means passport nationality.",
            "The country bridge is an aggregate statistical estimate, not a passenger-level identity match.",
            "The 2022 flight data uses monthly dates, while 2023 onward uses daily dates. The flight model uses a common monthly grain.",
            "Aircraft type, purpose of travel, hotel room inventory and event calendars are not included in the supplied folder.",
        ],
    }
    (OUTPUT_DIR / "model_report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    text = f"""# Air2Stay model report
 
## What the model does
 
The flight model estimates international hotel check-ins from flight capacity and point-to-point passengers. The stay model estimates daily hotel guests from current and recent hotel check-ins.
 
## Validation results
 
- Live default conversion-chain WMAPE: {metrics['live_chain_wmape']:.1%}
- Hybrid comparison WMAPE: {metrics['flight_to_checkins_wmape']:.1%}
- Seasonal conversion comparison WMAPE: {metrics['transparent_chain_wmape']:.1%}
- International daily guest WMAPE: {international_metrics['wmape']:.1%}
- Domestic daily guest WMAPE: {domestic_metrics['wmape']:.1%}
- Flight study period: {metrics['training_period']}
- Flight exam period: {metrics['validation_period']}
- International daily stay exam period: {international_metrics['validation_period']}
 
WMAPE means Weighted Mean Absolute Percentage Error: total absolute prediction mistakes divided by the total actual result. Lower is better. A score of 10% means the total absolute mistake is about 10 for every 100 actual values.
 
The flight-chain model studied January 2022 to December 2024, then took a closed-book exam on January to July 2025. The black Actual line is `New Arrivals` from the supplied `data international_train.xlsx`, summed across days and nationalities for each month. The daily stay score is a separate May-to-July 2025 exam on supplied daily `Guests` by nationality.
 
The flight-chain split is {metrics['training_months']} study months ({metrics['training_share']:.1%}) and {metrics['validation_months']} exam months ({metrics['validation_share']:.1%}). The daily international stay split is {international_metrics['training_rows']:,} study rows ({international_metrics['training_share']:.1%}) and {international_metrics['validation_rows']:,} exam rows ({international_metrics['validation_share']:.1%}). These are chronological splits: older observations teach the model and later observations test it.
 
Live-chain WMAPE uses {metrics['live_absolute_error_sum']} total absolute error divided by {metrics['validation_actual_sum']} actual check-ins. Hybrid WMAPE uses {metrics['hybrid_absolute_error_sum']} and the seasonal comparison uses {metrics['transparent_absolute_error_sum']} divided by that same actual total. All predictions and scores retain full precision; display rounding does not feed back into calculations.

The live check applies the browser's seats × occupancy × P2P share × constant training-only conversion formula to each held-out country-month's recorded flights, then sums across countries. It tests aggregate hotel check-ins conditional on those recorded flights, not future capacity or occupancy forecasts, route-level outcomes, visitor shares, guest nights, or user edits. Historical route baselines and nationality/stay profiles are descriptive summaries and are not claimed to be independently held out.

Occupancy above 100% is capped in Python and the browser. P2P share is rebased on capped passengers, preserving recorded P2P counts where capacity permits; raw input workbooks and raw source counts are retained. Conversion defaults use only 2022–2024. Range multipliers use live-chain residuals on the same seven check months, so they have no independent coverage validation.
 
## Uncertainty labels
 
- P50 is the central scenario formula result. It does not mean 50% accurate or a half-and-half chance.
- P10 and P90 are rough lower and higher planning lanes derived from only seven exam months. They are not guaranteed probabilities.
 
## Historical starting dials
 
- Weighted load factor: {metrics['weighted_load_factor']:.1%}
- Point-to-point share of passengers: {metrics['p2p_share']:.1%}
- Point-to-point passenger to hotel check-in conversion: {metrics['global_capture_rate']:.1%}
 
## Important limits
 
- The country bridge estimates group relationships. It does not identify individual passengers, and it does not create or remove total demand; it only allocates that total among nationalities.
- The supplied data does not separate returning residents from tourists.
- The supplied folder does not contain aircraft type, hotel room inventory, event calendars or purpose-of-travel data.
- The 2022 flight records use a different date grain, so the flight-to-hotel model works monthly.
"""
    (OUTPUT_DIR / "model_report.md").write_text(text, encoding="utf-8")
 
 
def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    WEB_DATA_DIR.mkdir(parents=True, exist_ok=True)
 
    print("Loading competition files...")
    flight = read_excel("flight_data.xlsx")
    international_train = read_excel("international_train.xlsx")
    international_test = read_excel("international_test.xlsx")
    domestic_train = read_excel("domestic_train.xlsx")
    domestic_test = read_excel("domestic_test.xlsx")
 
    print("Preparing flight and hotel history...")
    flight_monthly, route_seasonal = aggregate_flights(flight)
    hotel_monthly, seasonal_los, hotel_summary = aggregate_hotels(international_train)
    bridge = build_bridge(flight_monthly, hotel_monthly)
 
    print("Validating flight-to-hotel chain...")
    flight_metrics, flight_validation = validate_flight_chain(flight_monthly, hotel_monthly)
 
    print("Training daily stay models...")
    international_predictions, international_metrics = fit_stay_models(
        international_train, international_test, "Nationality"
    )
    domestic_predictions, domestic_metrics = fit_stay_models(
        domestic_train, domestic_test, None
    )
 
    international_predictions.to_csv(OUTPUT_DIR / "international_guest_predictions.csv", index=False)
    domestic_predictions.to_csv(OUTPUT_DIR / "domestic_guest_predictions.csv", index=False)
    flight_validation.to_csv(OUTPUT_DIR / "flight_chain_validation.csv", index=False)
    bridge.to_csv(OUTPUT_DIR / "country_bridge_matrix.csv", index=False)
    route_seasonal.to_csv(OUTPUT_DIR / "route_seasonal_baselines.csv", index=False)
    seasonal_los.to_csv(OUTPUT_DIR / "nationality_season_stay.csv", index=False)
 
    payload = scenario_payload(
        route_seasonal,
        bridge,
        seasonal_los,
        flight_metrics,
        international_metrics,
        flight_validation,
    )
    (WEB_DATA_DIR / "scenario_data.json").write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    from build_conversion_evidence import derive_evidence, write_evidence_module
    write_evidence_module(derive_evidence(ROOT), ROOT / "prototype" / "conversion_evidence.mjs")
    write_model_report(flight_metrics, international_metrics, domestic_metrics)
 
    print(json.dumps({
        "flight_chain_wmape": flight_metrics["flight_to_checkins_wmape"],
        "live_chain_wmape": flight_metrics["live_chain_wmape"],
        "transparent_chain_wmape": flight_metrics["transparent_chain_wmape"],
        "international_stay_wmape": international_metrics["wmape"],
        "domestic_stay_wmape": domestic_metrics["wmape"],
        "international_test_predictions": len(international_predictions),
        "domestic_test_predictions": len(domestic_predictions),
        "bridge_rows": len(bridge),
    }, indent=2))
 
 
if __name__ == "__main__":
    main()
