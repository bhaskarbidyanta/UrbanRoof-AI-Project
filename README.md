# UrbanRoof DDR AI Report Generator

This project generates a reliable DDR from an inspection PDF and a thermal PDF. It stores extracted images locally, writes an explicit image-mapping JSON, preserves page-level inspection evidence when image extraction is incomplete, and optionally refines the report with Google Gemini or Vertex AI.

## What Changed

- Images are stored locally under:
  - `data/inspection-images/`
  - `data/thermal-images/`
- A JSON image map is generated alongside the report:
  - `data/default-image-mapping.json`
- Inspection extraction now keeps page renders as valid evidence when pages contain composite photo layouts or incomplete image extraction.
- AI integration now uses Google AI environment variables instead of hardcoded credentials.
- The React UI renders local image paths directly and supports embedded-image plus page-render evidence.

## Stack

- Frontend: React, HTML, CSS
- Backend: Node.js built-in HTTP server
- PDF extraction: Python + `PyMuPDF`
- Optional AI: Google Gemini API or Vertex AI REST endpoint

## Key Files

- `server.js`
- `scripts/extract_ddr.py`
- `public/app.js`
- `public/styles.css`
- `data/default-report.json`
- `data/default-image-mapping.json`

## Run Locally

1. Generate the sample DDR and image map:

```powershell
python scripts/extract_ddr.py --inspection "C:\Users\Bhaskar\Downloads\Sample Report.pdf" --thermal "C:\Users\Bhaskar\Downloads\Thermal Images.pdf" --output data\default-report.json --public-base /data
```

2. Start the web app:

```powershell
node server.js
```

3. Open:

```text
http://localhost:3000
```

## API Routes

- `GET /api/report/default`
- `GET /api/image-map/default`
- `POST /api/generate`

## Google AI Setup

Gemini API option:

```powershell
$env:GOOGLE_API_KEY="your-key"
$env:GOOGLE_MODEL="gemini-1.5-flash"
```

Vertex AI option:

```powershell
$env:VERTEX_AI_ENDPOINT="https://your-vertex-endpoint"
$env:VERTEX_AI_ACCESS_TOKEN="your-token"
```

If no Google AI credentials are provided, the system still generates a report using deterministic extraction and synthesis.

## Reliability Rules

- No hardcoded API keys
- No hallucinated facts
- Missing information stays `Not Available`
- Uncertain image-to-area mapping is preserved as page-level evidence instead of being discarded
- Report generation proceeds even when extraction is partial

## Current Output

- `data/default-report.json` contains:
  - Property Issue Summary
  - Area-wise Observations
  - Root Cause
  - Severity
  - Recommended Actions
  - Missing Information
  - Conflicts
  - Local image paths under each section
- `data/default-image-mapping.json` links extracted image evidence to areas using page text and mapping method metadata

## Known Limitations

- Some thermal pages do not include explicit room names, so thermal evidence may be linked by sequence or page-level inference.
- The extraction is designed for robustness across similar reports, but radically different layouts would still benefit from OCR and stronger layout modeling.
