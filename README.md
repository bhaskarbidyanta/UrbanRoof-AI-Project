# UrbanRoof DDR AI Report Generator

React + Node + Python project for the UrbanRoof AI Generalist practical assignment. It reads an inspection PDF and a thermal PDF, extracts text plus embedded images, merges the findings into a structured DDR, and renders the final report in a client-friendly website.

## What This Project Does

- Generates a DDR with:
  - Property Issue Summary
  - Area-wise Observations
  - Probable Root Cause
  - Severity Assessment with reasoning
  - Recommended Actions
  - Additional Notes
  - Missing or Unclear Information
- Extracts source images from both PDFs and places them inside the relevant observation sections
- Uses a deterministic extraction pipeline by default
- Optionally refines narrative text with an LLM if `OPENAI_API_KEY` or `LLM_API_KEY` is configured

## Stack

- Frontend: React via browser runtime, HTML, CSS
- Backend: Node.js built-in HTTP server
- PDF pipeline: Python + `PyPDF2`

## Project Structure

- `server.js` - serves the app and exposes report generation APIs
- `scripts/extract_ddr.py` - PDF text/image extraction and DDR synthesis
- `public/index.html` - app shell
- `public/app.js` - React UI
- `public/styles.css` - report styling
- `data/default-report.json` - generated sample DDR
- `data/inspection-images/` - extracted inspection images
- `data/thermal-images/` - extracted thermal images

## Run Locally

1. Generate the sample DDR:

```powershell
python scripts/extract_ddr.py --inspection "C:\Users\Bhaskar\Downloads\Sample Report.pdf" --thermal "C:\Users\Bhaskar\Downloads\Thermal Images.pdf" --output data\default-report.json --public-base /data
```

2. Start the app:

```powershell
node server.js
```

3. Open:

```text
http://localhost:3000
```

## App API

- `GET /api/report/default`
  - returns the generated sample DDR JSON
- `POST /api/generate`
  - accepts uploaded PDFs as base64 JSON payloads from the website
  - if no files are uploaded in the UI, the backend falls back to the sample PDFs

## Optional LLM Setup

Set one of these before running the server if you want LLM refinement:

```powershell
$env:OPENAI_API_KEY="your-key"
$env:OPENAI_MODEL="gpt-4o-mini"
```

Optional overrides:

```powershell
$env:LLM_API_URL="https://api.openai.com/v1/chat/completions"
$env:LLM_API_KEY="your-key"
$env:LLM_MODEL="gpt-4o-mini"
```

If no key is configured, the app still works using the rule-based extraction pipeline.

## Deployment Notes

This project can be deployed as a simple Node web service on Render, Railway, or similar platforms.

- Build command: `none`
- Start command: `node server.js`
- Runtime requirements:
  - Node 24+
  - Python 3.11+
- For a hosted demo, either:
  - pre-generate `data/default-report.json` and keep the sample assets in `data/`
  - or provide writable disk storage if you want fresh user uploads to be processed on the server

## Known Limitations

- The thermal PDF does not clearly label room names, so thermal images are attached by document order and the report explicitly says that mapping is inferred.
- Some metadata fields in the source PDFs are blank, so the output correctly marks them as `Not Available`.
- The extraction logic is designed to generalize to similar reports, but heavily different PDF templates would benefit from stronger layout-aware parsing or OCR.
- LLM use is optional and currently focused on polishing report wording, not changing factual extraction.

## Suggested Demo Talking Points

- How the pipeline combines inspection observations with thermal evidence
- How missing data and uncertain image-to-room mapping are handled explicitly instead of being invented
- Why the system uses deterministic parsing first, then optional LLM refinement second
- How you would improve it next:
  - better OCR/layout parsing
  - stronger room/image linking
  - persistence in MongoDB or object storage
  - export to branded PDF
