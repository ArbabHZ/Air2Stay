// Generated from supplied workbooks by src/build_conversion_evidence.py.
// Training-only calibration; scores retain full precision.
export const CONVERSION_EVIDENCE = {
  "trainingPeriod": "2022-01 to 2024-12",
  "checkPeriod": "2025-01 to 2025-07",
  "trainingMonths": 36,
  "checkMonths": 7,
  "commonMonths": 43,
  "globalRate": 0.41964800295570037,
  "trainingP2pPassengers": 13100110.0,
  "trainingHotelArrivals": 5497435.0,
  "monthlyRates": {
    "1": 0.4231988773519617,
    "2": 0.46277880317879727,
    "3": 0.4666607268877994,
    "4": 0.41542853662363743,
    "5": 0.4267498287051949,
    "6": 0.4205398077801674,
    "7": 0.4066218403709762,
    "8": 0.3540934786133141,
    "9": 0.378959192485242,
    "10": 0.4371084939808595,
    "11": 0.4519298428813526,
    "12": 0.4198475425621319
  },
  "monthlyEvidence": {
    "1": {
      "months": 3,
      "hotelArrivals": 415720.0,
      "p2pPassengers": 978808.0,
      "rawRate": 0.42472068066464513,
      "startingRate": 0.4231988773519617
    },
    "2": {
      "months": 3,
      "hotelArrivals": 456385.0,
      "p2pPassengers": 948306.0,
      "rawRate": 0.4812634318458388,
      "startingRate": 0.46277880317879727
    },
    "3": {
      "months": 3,
      "hotelArrivals": 454039.0,
      "p2pPassengers": 932684.0,
      "rawRate": 0.4868090371444133,
      "startingRate": 0.4666607268877994
    },
    "4": {
      "months": 3,
      "hotelArrivals": 426952.0,
      "p2pPassengers": 1032232.0,
      "rawRate": 0.41362019390989624,
      "startingRate": 0.41542853662363743
    },
    "5": {
      "months": 3,
      "hotelArrivals": 431538.0,
      "p2pPassengers": 1004059.0,
      "rawRate": 0.4297934683121211,
      "startingRate": 0.4267498287051949
    },
    "6": {
      "months": 3,
      "hotelArrivals": 360236.0,
      "p2pPassengers": 855826.0,
      "rawRate": 0.42092200984779615,
      "startingRate": 0.4205398077801674
    },
    "7": {
      "months": 3,
      "hotelArrivals": 423268.0,
      "p2pPassengers": 1055428.0,
      "rawRate": 0.4010391992632373,
      "startingRate": 0.4066218403709762
    },
    "8": {
      "months": 3,
      "hotelArrivals": 455768.0,
      "p2pPassengers": 1398067.0,
      "rawRate": 0.3259986824665771,
      "startingRate": 0.3540934786133141
    },
    "9": {
      "months": 3,
      "hotelArrivals": 397948.0,
      "p2pPassengers": 1100760.0,
      "rawRate": 0.3615211308550456,
      "startingRate": 0.378959192485242
    },
    "10": {
      "months": 3,
      "hotelArrivals": 530869.0,
      "p2pPassengers": 1194060.0,
      "rawRate": 0.44459156156307056,
      "startingRate": 0.4371084939808595
    },
    "11": {
      "months": 3,
      "hotelArrivals": 537965.0,
      "p2pPassengers": 1155014.0,
      "rawRate": 0.46576491713520357,
      "startingRate": 0.4519298428813526
    },
    "12": {
      "months": 3,
      "hotelArrivals": 606747.0,
      "p2pPassengers": 1444866.0,
      "rawRate": 0.4199330595363169,
      "startingRate": 0.4198475425621319
    }
  },
  "countryRatesAvailable": false,
  "conclusion": "Compare the seasonal and constant training-only scores. These aggregate checks do not establish route-level demand accuracy or a benefit from seasonal conversion.",
  "method": "Seasonal rate = 70% of the training month-of-year aggregate hotel-arrivals / P2P ratio + 30% of the overall training aggregate ratio. Ratios use only common months before 2025-01.",
  "scope": "All included markets combined. This is an aggregate planning calibration, not an observed route-specific or person-level hotel-choice probability.",
  "validation": {
    "wmape": 0.06909652354902426,
    "absoluteErrorSum": 107146.5280404774,
    "actualSum": 1550679.0,
    "constantTrainingGlobalWmape": 0.06555415933133502,
    "rows": [
      {
        "month": "2025-01",
        "actual": 281088.0,
        "predicted": 237852.15783363246,
        "p2pPassengers": 562034.0
      },
      {
        "month": "2025-02",
        "actual": 226737.0,
        "predicted": 228396.61106924136,
        "p2pPassengers": 493533.0
      },
      {
        "month": "2025-03",
        "actual": 194162.0,
        "predicted": 214399.80439696924,
        "p2pPassengers": 459434.0
      },
      {
        "month": "2025-04",
        "actual": 245515.0,
        "predicted": 251285.6595185157,
        "p2pPassengers": 604883.0
      },
      {
        "month": "2025-05",
        "actual": 201695.0,
        "predicted": 206812.78223659768,
        "p2pPassengers": 484623.0
      },
      {
        "month": "2025-06",
        "actual": 190713.0,
        "predicted": 180765.67205584273,
        "p2pPassengers": 429842.0
      },
      {
        "month": "2025-07",
        "actual": 210769.0,
        "predicted": 189591.49929137138,
        "p2pPassengers": 466260.0
      }
    ]
  },
  "sourceRows": {
    "flight": 117608,
    "hotel": 58622
  },
  "flightCountries": 33,
  "hotelNationalities": 45,
  "limitations": [
    "Flight country is departure country; hotel country is passport nationality. The sources do not directly identify hotel arrivals by flight departure market.",
    "Month-of-year rates have limited training observations. Check-period calendar-month coverage must be read from the validation rows; missing seasons are not validated.",
    "This check uses recorded P2P totals for the same months. It does not validate future demand, new routes, purpose presets, event effects, nationality allocation, or route guest nights.",
    "Compare both reported WMAPE scores before claiming improvement. A seasonal method is not automatically more accurate."
  ],
  "sources": [
    {
      "file": "flight_data.xlsx",
      "sheet": "Export",
      "columns": [
        "Date",
        "Total P2P",
        "Total PAX",
        "Total Seats",
        "Departure Country Name"
      ],
      "sha256": "5520c0a95126636ee90084209c8e4110bd0b0b095d64cc9dbac37356ae00a9f8"
    },
    {
      "file": "data international_train.xlsx",
      "sheet": "Export",
      "columns": [
        "Date",
        "New Arrivals",
        "Nationality"
      ],
      "sha256": "beaa3c39d3f9bf891667fdb50a2584e56a3b02dc3c459b17ea312022415fad44"
    }
  ]
};
