const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && !process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(path.join(__dirname, ".env"));

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const TMP_DIR = path.join(ROOT, "tmp");
const DEFAULT_REPORT = path.join(DATA_DIR, "default-report.json");
const DEFAULT_IMAGE_MAP = path.join(DATA_DIR, "default-image-mapping.json");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

for (const dir of [DATA_DIR, TMP_DIR, path.join(DATA_DIR, "inspection-images"), path.join(DATA_DIR, "thermal-images")]) {
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
  return resolved.startsWith(baseDir) ? resolved : null;
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
  const base64 = filePayload.content.includes(",") ? filePayload.content.split(",").pop() : filePayload.content;
  fs.writeFileSync(targetPath, Buffer.from(base64, "base64"));
}

function runExtractor(inspectionPath, thermalPath, outputPath) {
  ensureDir(path.dirname(outputPath));
  const result = spawnSync("python", [
    path.join(ROOT, "scripts", "extract_ddr.py"),
    "--inspection",
    inspectionPath,
    "--thermal",
    thermalPath,
    "--output",
    outputPath,
    "--public-base",
    "/data"
  ], { cwd: ROOT, encoding: "utf-8" });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "PDF extraction failed.");
  }

  return JSON.parse(fs.readFileSync(outputPath, "utf-8"));
}

function buildGeminiPrompt(report) {
  return [
    "You are generating a reliable Detailed Diagnostic Report.",
    "Only use the extracted evidence provided.",
    "Do not hallucinate any room names, causes, or measurements.",
    "If something is missing, return 'Not Available'.",
    "If mapping is uncertain, say so.",
    "Return strict JSON with keys:",
    "propertyIssueSummary, areaWiseObservations, missingInformation, conflicts.",
    "propertyIssueSummary must have headline and keyPoints.",
    "Each areaWiseObservations item must have: area, observation, rootCause, severityLabel, severityReasoning, recommendedActions, thermalAssessment, missingInformation.",
    JSON.stringify({
      evidence: {
        rawEvidence: report.rawEvidence,
        areaWiseObservations: report.areaWiseObservations,
        missingInformation: report.missingInformation,
        conflicts: report.conflicts
      }
    })
  ].join(" ");
}

async function callGemini(report) {
  const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
  const model = process.env.GOOGLE_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";
  if (apiKey) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        generationConfig: { responseMimeType: "application/json" },
        contents: [{ role: "user", parts: [{ text: buildGeminiPrompt(report) }] }]
      })
    });
    if (!response.ok) {
      throw new Error(`Gemini request failed with status ${response.status}`);
    }
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    return JSON.parse(text);
  }

  const vertexEndpoint = process.env.VERTEX_AI_ENDPOINT;
  const vertexToken = process.env.VERTEX_AI_ACCESS_TOKEN;
  if (vertexEndpoint && vertexToken) {
    const response = await fetch(vertexEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${vertexToken}`
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: buildGeminiPrompt(report) }] }],
        generationConfig: { responseMimeType: "application/json" }
      })
    });
    if (!response.ok) {
      throw new Error(`Vertex AI request failed with status ${response.status}`);
    }
    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    return JSON.parse(text);
  }

  return null;
}

async function maybeEnhanceWithGoogleAi(report, outputPath) {
  try {
    const aiResult = await callGemini(report);
    if (!aiResult) {
      report.meta.ai = {
        attempted: false,
        provider: "deterministic-fallback",
        note: "No Google AI credentials found. The report uses deterministic extraction and synthesis."
      };
      return report;
    }

    if (aiResult.propertyIssueSummary) {
      report.propertyIssueSummary = aiResult.propertyIssueSummary;
    }
    if (Array.isArray(aiResult.areaWiseObservations)) {
      report.areaWiseObservations = report.areaWiseObservations.map((existing, index) => {
        const refined = aiResult.areaWiseObservations[index];
        if (!refined) {
          return existing;
        }
        return {
          ...existing,
          observation: refined.observation || existing.observation,
          rootCause: refined.rootCause || existing.rootCause,
          severity: {
            label: refined.severityLabel || existing.severity.label,
            reasoning: refined.severityReasoning || existing.severity.reasoning
          },
          recommendedActions: Array.isArray(refined.recommendedActions) && refined.recommendedActions.length
            ? refined.recommendedActions
            : existing.recommendedActions,
          thermalAssessment: Array.isArray(refined.thermalAssessment) && refined.thermalAssessment.length
            ? refined.thermalAssessment
            : existing.thermalAssessment,
          missingInformation: Array.isArray(refined.missingInformation)
            ? refined.missingInformation
            : existing.missingInformation
        };
      });
    }
    if (Array.isArray(aiResult.missingInformation)) {
      report.missingInformation = aiResult.missingInformation;
    }
    if (Array.isArray(aiResult.conflicts)) {
      report.conflicts = aiResult.conflicts;
    }

    report.meta.ai = {
      attempted: true,
      provider: process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY ? "Gemini API" : "Vertex AI",
      model: process.env.GOOGLE_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash",
      note: "Narrative sections were refined by Google AI while preserving local evidence and image paths."
    };
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    report.meta.ai = {
      attempted: true,
      provider: "deterministic-fallback",
      note: `Google AI refinement skipped: ${error.message}`
    };
    return report;
  }
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
      inspectionPath = payload.inspectionPath || "C:\\Users\\Bhaskar\\Downloads\\Sample Report.pdf";
      thermalPath = payload.thermalPath || "C:\\Users\\Bhaskar\\Downloads\\Thermal Images.pdf";
    }

    const outputPath = path.join(runDir, "report.json");
    let report = runExtractor(inspectionPath, thermalPath, outputPath);
    if (payload.useAi !== false) {
      report = await maybeEnhanceWithGoogleAi(report, outputPath);
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
      sendJson(res, 404, { error: "Default report not generated yet." });
      return;
    }
    sendFile(res, DEFAULT_REPORT);
    return;
  }

  if (req.method === "GET" && pathname === "/api/image-map/default") {
    if (!fs.existsSync(DEFAULT_IMAGE_MAP)) {
      sendJson(res, 404, { error: "Default image mapping not generated yet." });
      return;
    }
    sendFile(res, DEFAULT_IMAGE_MAP);
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
