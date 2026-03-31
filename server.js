const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const TMP_DIR = path.join(ROOT, "tmp");
const DEFAULT_REPORT = path.join(DATA_DIR, "default-report.json");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

for (const dir of [DATA_DIR, TMP_DIR]) {
  ensureDir(dir);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf"
  };

  fs.readFile(filePath, (error, content) => {
    if (error) {
      sendJson(res, 404, { error: "File not found." });
      return;
    }

    res.writeHead(200, { "Content-Type": contentTypes[ext] || "application/octet-stream" });
    res.end(content);
  });
}

function safeJoin(baseDir, requestPath) {
  const resolved = path.normalize(path.join(baseDir, requestPath));
  if (!resolved.startsWith(baseDir)) {
    return null;
  }
  return resolved;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 50 * 1024 * 1024) {
        reject(new Error("Request payload is too large."));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function writeBase64File(targetPath, filePayload) {
  if (!filePayload || !filePayload.content) {
    throw new Error("Missing uploaded file payload.");
  }

  const base64 = filePayload.content.includes(",")
    ? filePayload.content.split(",").pop()
    : filePayload.content;
  fs.writeFileSync(targetPath, Buffer.from(base64, "base64"));
}

async function maybeEnhanceWithLlm(report) {
  const apiKey = process.env.OPENAI_API_KEY || process.env.LLM_API_KEY;
  if (!apiKey) {
    report.meta.llm = {
      attempted: false,
      provider: "fallback",
      note: "No LLM API key found. The report uses deterministic extraction and synthesis."
    };
    return report;
  }

  const endpoint =
    process.env.LLM_API_URL || "https://api.openai.com/v1/chat/completions";
  const model = process.env.OPENAI_MODEL || process.env.LLM_MODEL || "gpt-4o-mini";

  const prompt = [
    "You are refining a property diagnostic report.",
    "Keep every fact grounded in the provided JSON only.",
    "Do not invent room labels, causes, or images.",
    "If data is missing, keep 'Not Available'.",
    "Return strict JSON with keys:",
    "propertyIssueSummary, additionalNotes, missingOrUnclearInformation, areaWiseObservations.",
    "Each item in areaWiseObservations must have:",
    "area, observation, probableRootCause, severity, severityReasoning, recommendedActions."
  ].join(" ");

  const body = {
    model,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: prompt },
      {
        role: "user",
        content: JSON.stringify({
          propertyIssueSummary: report.propertyIssueSummary,
          additionalNotes: report.additionalNotes,
          missingOrUnclearInformation: report.missingOrUnclearInformation,
          areaWiseObservations: report.areaWiseObservations.map((area) => ({
            area: area.area,
            observation: area.observation,
            probableRootCause: area.probableRootCause,
            severity: area.severity.label,
            severityReasoning: area.severity.reasoning,
            recommendedActions: area.recommendedActions
          }))
        })
      }
    ]
  };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      throw new Error(`LLM request failed with status ${response.status}`);
    }

    const result = await response.json();
    const rawContent = result.choices?.[0]?.message?.content;
    const parsed = JSON.parse(rawContent || "{}");

    if (parsed.propertyIssueSummary) {
      report.propertyIssueSummary = parsed.propertyIssueSummary;
    }
    if (Array.isArray(parsed.additionalNotes) && parsed.additionalNotes.length) {
      report.additionalNotes = parsed.additionalNotes;
    }
    if (Array.isArray(parsed.missingOrUnclearInformation) && parsed.missingOrUnclearInformation.length) {
      report.missingOrUnclearInformation = parsed.missingOrUnclearInformation;
    }
    if (Array.isArray(parsed.areaWiseObservations)) {
      report.areaWiseObservations = report.areaWiseObservations.map((existing, index) => {
        const refined = parsed.areaWiseObservations[index];
        if (!refined) {
          return existing;
        }
        return {
          ...existing,
          observation: refined.observation || existing.observation,
          probableRootCause: refined.probableRootCause || existing.probableRootCause,
          severity: {
            label: refined.severity || existing.severity.label,
            reasoning: refined.severityReasoning || existing.severity.reasoning
          },
          recommendedActions: Array.isArray(refined.recommendedActions) && refined.recommendedActions.length
            ? refined.recommendedActions
            : existing.recommendedActions
        };
      });
    }

    report.meta.llm = {
      attempted: true,
      provider: endpoint.includes("openai.com") ? "OpenAI-compatible" : "Custom",
      model,
      note: "Narrative fields refined with an LLM while preserving extracted facts."
    };
    return report;
  } catch (error) {
    report.meta.llm = {
      attempted: true,
      provider: "fallback",
      model,
      note: `LLM refinement skipped: ${error.message}`
    };
    return report;
  }
}

function runExtractor(inspectionPath, thermalPath, outputPath) {
  ensureDir(path.dirname(outputPath));
  const result = spawnSync(
    "python",
    [
      path.join(ROOT, "scripts", "extract_ddr.py"),
      "--inspection",
      inspectionPath,
      "--thermal",
      thermalPath,
      "--output",
      outputPath,
      "--public-base",
      "/data"
    ],
    {
      cwd: ROOT,
      encoding: "utf-8"
    }
  );

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "PDF extraction failed.");
  }

  return JSON.parse(fs.readFileSync(outputPath, "utf-8"));
}

async function handleGenerate(req, res) {
  try {
    const rawBody = await readRequestBody(req);
    const payload = JSON.parse(rawBody || "{}");
    const runId = `run-${Date.now()}`;
    const runDir = path.join(DATA_DIR, runId);
    ensureDir(runDir);

    let inspectionPath;
    let thermalPath;

    if (payload.inspectionPdf?.content && payload.thermalPdf?.content) {
      inspectionPath = path.join(TMP_DIR, `${runId}-inspection.pdf`);
      thermalPath = path.join(TMP_DIR, `${runId}-thermal.pdf`);
      writeBase64File(inspectionPath, payload.inspectionPdf);
      writeBase64File(thermalPath, payload.thermalPdf);
    } else {
      inspectionPath =
        payload.inspectionPath || "C:\\Users\\Bhaskar\\Downloads\\Sample Report.pdf";
      thermalPath =
        payload.thermalPath || "C:\\Users\\Bhaskar\\Downloads\\Thermal Images.pdf";
    }

    const outputPath = path.join(runDir, "report.json");
    let report = runExtractor(inspectionPath, thermalPath, outputPath);
    if (payload.useLlm !== false) {
      report = await maybeEnhanceWithLlm(report);
      fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    }

    sendJson(res, 200, report);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/api/report/default") {
    if (!fs.existsSync(DEFAULT_REPORT)) {
      sendJson(res, 404, {
        error: "Default report not generated yet. Run `npm run generate:sample` first."
      });
      return;
    }

    sendFile(res, DEFAULT_REPORT);
    return;
  }

  if (req.method === "POST" && pathname === "/api/generate") {
    await handleGenerate(req, res);
    return;
  }

  if (pathname.startsWith("/data/")) {
    const relativePath = pathname.replace("/data/", "");
    const filePath = safeJoin(DATA_DIR, relativePath);
    if (!filePath) {
      sendJson(res, 400, { error: "Invalid data path." });
      return;
    }
    sendFile(res, filePath);
    return;
  }

  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = safeJoin(PUBLIC_DIR, requested);
  if (filePath && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    sendFile(res, filePath);
    return;
  }

  sendFile(res, path.join(PUBLIC_DIR, "index.html"));
});

server.listen(PORT, () => {
  console.log(`DDR report app running at http://localhost:${PORT}`);
});
