# Lariat  -  real bill data

This is an independent copy of the original Lariat prototype. The visual design and page structure are preserved, but the bill feed uses the real records in `texas_bill_summaries.json`.

## Run locally

From the project root:

```bash
python3 -m http.server 8000 --directory Lariat-real
```

Then open <http://localhost:8000/> and select **Bill feed**.

The feed loads the JSON file in the browser, so use a local HTTP server instead of opening `index.html` directly with `file://`.

The displayed fields are the source dataset's `identifier`, `title`, `affects`, `changes`, `business_impact`, and `impact_level`. Confirm current legislative status with official Texas sources before relying on any record; this is not legal advice.
