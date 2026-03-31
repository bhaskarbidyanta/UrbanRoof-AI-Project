const { useEffect, useState } = React;

async function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function SummaryCard({ title, value, tone }) {
  return (
    <article className={`summary-card ${tone || ""}`}>
      <span>{title}</span>
      <strong>{value}</strong>
    </article>
  );
}

function AiStatusBadge({ report }) {
  const aiMeta = report?.meta?.ai;
  const connected = aiMeta?.provider && aiMeta.provider !== "deterministic-fallback";
  const label = connected ? "Gemini Connected" : "Fallback Mode";
  const detail = connected
    ? `${aiMeta.provider} · ${aiMeta.model || "model not specified"}`
    : aiMeta?.note || "Google AI credentials not detected";

  return (
    <div className={`ai-badge ${connected ? "online" : "offline"}`}>
      <strong>{label}</strong>
      <span>{detail}</span>
    </div>
  );
}

function EvidenceGallery({ images }) {
  return (
    <div className="image-group">
      <h4>Local Image Evidence</h4>
      <div className="image-grid">
        {images.map((image, index) => (
          <figure className="report-image" key={`${image.path}-${index}`}>
            {image.path && image.path !== "Image Not Available" ? (
              <img src={image.path} alt={`Evidence page ${image.page}`} />
            ) : (
              <div className="image-placeholder">Image Not Available</div>
            )}
            <figcaption>
              <strong>{image.documentType} · Page {image.page}</strong>
              <span>{image.evidenceType}</span>
              <span>{image.mappingMethod}</span>
              <span>{image.mappingReason}</span>
              <span>{image.path || "Image Not Available"}</span>
            </figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

function AreaSection({ area }) {
  return (
    <section className="area-section">
      <div className="section-topline">
        <span className="pill">{area.severity.label}</span>
        <h3>{area.area}</h3>
      </div>
      <p>{area.observation}</p>
      <div className="details-grid">
        <div>
          <h4>Root Cause</h4>
          <p>{area.rootCause || "Not Available"}</p>
        </div>
        <div>
          <h4>Severity</h4>
          <p>
            <strong>{area.severity.label}.</strong> {area.severity.reasoning}
          </p>
        </div>
      </div>
      <div className="details-grid">
        <div>
          <h4>Recommended Actions</h4>
          <ul>
            {area.recommendedActions.map((action, index) => (
              <li key={`${area.area}-action-${index}`}>{action}</li>
            ))}
          </ul>
        </div>
        <div>
          <h4>Thermal Assessment</h4>
          <ul>
            {area.thermalAssessment.map((item, index) => (
              <li key={`${area.area}-thermal-${index}`}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
      <EvidenceGallery images={area.imageEvidence} />
      <div className="source-notes">
        {area.canonicalAreas.map((item, index) => (
          <span key={`${area.area}-canonical-${index}`}>{item}</span>
        ))}
      </div>
    </section>
  );
}

function App() {
  const [report, setReport] = useState(null);
  const [inspectionFile, setInspectionFile] = useState(null);
  const [thermalFile, setThermalFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [useAi, setUseAi] = useState(true);

  useEffect(() => {
    fetch("/api/report/default")
      .then((response) => {
        if (!response.ok) {
          throw new Error("Default report is not generated yet.");
        }
        return response.json();
      })
      .then(setReport)
      .catch(() => undefined);
  }, []);

  async function generateReport(event) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const payload = { useAi };
      if (inspectionFile && thermalFile) {
        payload.inspectionPdf = { name: inspectionFile.name, content: await fileToDataUrl(inspectionFile) };
        payload.thermalPdf = { name: thermalFile.name, content: await fileToDataUrl(thermalFile) };
      }
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Generation failed.");
      }
      setReport(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const imageCount = report
    ? report.areaWiseObservations.reduce((sum, area) => sum + area.imageEvidence.filter((item) => item.path !== "Image Not Available").length, 0)
    : 0;

  return (
    <main className="page-shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Reliable AI DDR Pipeline</p>
          <h1>Local-Image DDR Generator</h1>
          <p className="hero-text">
            This version stores extracted evidence locally, keeps page-level inspection renders when photo extraction is incomplete,
            uses explainable image mapping, and optionally refines the report with Google Gemini or Vertex AI.
          </p>
        </div>
        <form className="upload-card" onSubmit={generateReport}>
          <label>
            Inspection Report PDF
            <input type="file" accept="application/pdf" onChange={(e) => setInspectionFile(e.target.files[0] || null)} />
          </label>
          <label>
            Thermal Report PDF
            <input type="file" accept="application/pdf" onChange={(e) => setThermalFile(e.target.files[0] || null)} />
          </label>
          <label className="toggle">
            <input type="checkbox" checked={useAi} onChange={(e) => setUseAi(e.target.checked)} />
            <span>Use Google AI when environment credentials are available</span>
          </label>
          <button type="submit" disabled={loading}>{loading ? "Generating..." : "Generate DDR"}</button>
          <p className="helper">If no files are uploaded, the sample PDFs from your Downloads folder are used.</p>
          {error ? <p className="error-text">{error}</p> : null}
        </form>
      </section>

      {report ? (
        <>
          <section className="status-strip">
            <AiStatusBadge report={report} />
          </section>

          <section className="summary-strip">
            <SummaryCard title="Areas" value={report.areaWiseObservations.length} />
            <SummaryCard title="Images Linked" value={imageCount} />
            <SummaryCard title="Image Map" value={report.meta.imageMappingPath || "Not Available"} />
            <SummaryCard title="AI Status" value={report.meta.ai?.note || "Deterministic fallback"} tone="warn" />
          </section>

          <section className="report-shell">
            <div className="report-header">
              <div>
                <p className="eyebrow">Generated Report</p>
                <h2>{report.meta.title}</h2>
              </div>
              <div className="property-meta">
                <span>Inspection PDF: {report.meta.generatedFrom.inspectionPdf}</span>
                <span>Thermal PDF: {report.meta.generatedFrom.thermalPdf}</span>
                <span>Mapping File: {report.meta.imageMappingPath}</span>
              </div>
            </div>

            <section className="report-block">
              <h3>Property Issue Summary</h3>
              <p className="headline">{report.propertyIssueSummary.headline}</p>
              <ul>
                {report.propertyIssueSummary.keyPoints.map((point, index) => (
                  <li key={`summary-${index}`}>{point}</li>
                ))}
              </ul>
            </section>

            <section className="report-block">
              <h3>Area-wise Observations</h3>
              <div className="area-list">
                {report.areaWiseObservations.map((area) => <AreaSection area={area} key={area.area} />)}
              </div>
            </section>

            <section className="report-block twin">
              <div>
                <h3>Missing Information</h3>
                <ul>
                  {report.missingInformation.map((item, index) => <li key={`missing-${index}`}>{item}</li>)}
                </ul>
              </div>
              <div>
                <h3>Conflicts</h3>
                <ul>
                  {report.conflicts.map((item, index) => <li key={`conflict-${index}`}>{item}</li>)}
                </ul>
              </div>
            </section>

            <section className="report-block">
              <h3>Reliability Notes</h3>
              <ul>
                {report.meta.reliability.notes.map((note, index) => <li key={`rel-${index}`}>{note}</li>)}
              </ul>
            </section>
          </section>
        </>
      ) : (
        <section className="empty-state">
          <h2>No report loaded yet</h2>
          <p>Generate a report to see local evidence mapping and structured DDR sections.</p>
        </section>
      )}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
