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

function ImageGallery({ title, images }) {
  return (
    <div className="image-group">
      <h4>{title}</h4>
      <div className="image-grid">
        {images.map((image, index) => (
          <figure className="report-image" key={`${title}-${index}`}>
            {image.src ? (
              <img src={image.src} alt={image.caption || image.label} />
            ) : (
              <div className="image-placeholder">Image Not Available</div>
            )}
            <figcaption>
              <strong>{image.label}</strong>
              <span>{image.caption}</span>
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
          <h4>Probable Root Cause</h4>
          <p>{area.probableRootCause || "Not Available"}</p>
        </div>
        <div>
          <h4>Severity Assessment</h4>
          <p>
            <strong>{area.severity.label}.</strong> {area.severity.reasoning}
          </p>
        </div>
      </div>
      <div>
        <h4>Recommended Actions</h4>
        <ul>
          {area.recommendedActions.map((action, index) => (
            <li key={`${area.area}-action-${index}`}>{action}</li>
          ))}
        </ul>
      </div>
      <ImageGallery title="Inspection Evidence" images={area.supportingImages.inspection} />
      <ImageGallery title="Thermal Evidence" images={area.supportingImages.thermal} />
      <div className="source-notes">
        {area.sourceNotes.map((note, index) => (
          <span key={`${area.area}-note-${index}`}>{note}</span>
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
  const [useLlm, setUseLlm] = useState(true);

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
      const payload = { useLlm };
      if (inspectionFile && thermalFile) {
        payload.inspectionPdf = {
          name: inspectionFile.name,
          content: await fileToDataUrl(inspectionFile),
        };
        payload.thermalPdf = {
          name: thermalFile.name,
          content: await fileToDataUrl(thermalFile),
        };
      }

      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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

  const highSeverityCount = report
    ? report.areaWiseObservations.filter((item) => item.severity.label === "High").length
    : 0;

  return (
    <main className="page-shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">AI Generalist Assignment</p>
          <h1>Detailed Diagnostic Report Generator</h1>
          <p className="hero-text">
            Upload an inspection report and a thermal report, then generate a client-ready DDR
            with merged findings, severity reasoning, recommended actions, and source images placed
            under the matching observations.
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
            <input type="checkbox" checked={useLlm} onChange={(e) => setUseLlm(e.target.checked)} />
            <span>Refine narrative fields with LLM when API credentials are configured</span>
          </label>
          <button type="submit" disabled={loading}>
            {loading ? "Generating..." : "Generate DDR"}
          </button>
          <p className="helper">
            If no files are uploaded, the app uses the sample PDFs referenced in the assignment.
          </p>
          {error ? <p className="error-text">{error}</p> : null}
        </form>
      </section>

      {report ? (
        <>
          <section className="summary-strip">
            <SummaryCard title="Areas Analysed" value={report.areaWiseObservations.length} />
            <SummaryCard title="High Severity Areas" value={highSeverityCount} tone="warn" />
            <SummaryCard title="Inspection Date" value={report.meta.property.inspectionDate || "Not Available"} />
            <SummaryCard title="LLM Status" value={report.meta.llm?.note || "Rule-based only"} />
          </section>

          <section className="report-shell">
            <div className="report-header">
              <div>
                <p className="eyebrow">Generated Report</p>
                <h2>{report.meta.title}</h2>
              </div>
              <div className="property-meta">
                <span>Customer: {report.meta.property.customerName || "Not Available"}</span>
                <span>Address: {report.meta.property.address || "Not Available"}</span>
                <span>Property Type: {report.meta.property.propertyType || "Not Available"}</span>
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
                {report.areaWiseObservations.map((area) => (
                  <AreaSection area={area} key={area.area} />
                ))}
              </div>
            </section>

            <section className="report-block twin">
              <div>
                <h3>Additional Notes</h3>
                <ul>
                  {report.additionalNotes.map((note, index) => (
                    <li key={`note-${index}`}>{note}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>Missing or Unclear Information</h3>
                <ul>
                  {report.missingOrUnclearInformation.map((item, index) => (
                    <li key={`missing-${index}`}>{item}</li>
                  ))}
                </ul>
              </div>
            </section>

            <section className="report-block">
              <h3>Conflict Handling</h3>
              <ul>
                {report.conflicts.map((item, index) => (
                  <li key={`conflict-${index}`}>{item}</li>
                ))}
              </ul>
            </section>
          </section>
        </>
      ) : (
        <section className="empty-state">
          <h2>No report loaded yet</h2>
          <p>Generate a report from the sample documents or upload a fresh pair of PDFs.</p>
        </section>
      )}
    </main>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
