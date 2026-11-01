# Numerical reliability fixes — 1 November 2026

Executed `node tests/numbers.mjs`: passed 396 unchanged route/month cases, 2,376 combinations of visitor-mix overrides, flight changes and event increases, negative-flight sensitivity checks, and seven rejected invalid inputs per route. `node --check prototype/app.mjs` passed.

Live Streamlit Browser checks:

- India, December, zero extra flights: +0 check-ins and +0 guest nights; baseline 240,131 nights.
- Changing the first visitor share to 100 and applying leaves baseline 240,131 and scenario 242,243 nights unchanged. Nationality allocation changes.
- After editing India's mix and event uplift, confirming Iran starts with Kuwait's visitor mix and event uplift +0%.
- Average stay 100: clear 1–10 message, result cards hidden; Reset restores results.
- No browser error logs captured in this verification session.

Implementation notes: readable rounded controls retain their original precise values until changed. Baseline allocation uses the historical bridge independently of scenario edits. Route/proxy/month selections load fresh defaults. Shared engine checks reject invalid numeric inputs; the assistant rejects requests outside the same limits. Flights filled above 100% are capped in the derived route assumptions, without changing source files. This also applies to historical ratios above one; it is an explicit capacity constraint and should be included when model validation is updated.

Other audit findings, including map placement, packaging, country aliases, validation claims, and responsive navigation, remain separate work.
