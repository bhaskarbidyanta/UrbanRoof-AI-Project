# -*- coding: utf-8 -*-
import argparse
import hashlib
import json
import os
import re
from collections import defaultdict
from pathlib import Path

import fitz


CANONICAL_AREAS = ["Hall", "Bedroom", "Kitchen", "Bathroom", "External"]
AREA_PATTERNS = {
    "Hall": [r"\bhall\b"],
    "Bedroom": [r"\bbedroom\b", r"master bedroom", r"common bedroom"],
    "Kitchen": [r"\bkitchen\b"],
    "Bathroom": [r"bathroom", r"\bwc\b", r"tile joint", r"nahani", r"plumbing"],
    "External": [r"external wall", r"parking", r"ceiling below", r"duct", r"crack", r"seepage"],
}


def ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def normalize_spaces(text):
    return re.sub(r"\s+", " ", text or "").strip()


def slugify(value):
    return re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")


def infer_areas(text):
    normalized = normalize_spaces(text).lower()
    matches = []
    for area, patterns in AREA_PATTERNS.items():
        if any(re.search(pattern, normalized, re.IGNORECASE) for pattern in patterns):
            matches.append(area)
    return matches or ["Page-level"]


def build_mapping_reason(text, page_number, areas, method):
    if method == "keyword":
        return f"Assigned from page {page_number} using nearby text keywords: {', '.join(areas)}."
    if method == "sequence":
        return f"Assigned to {', '.join(areas)} by document order because the page text did not label a room clearly."
    return f"Kept as page-level evidence from page {page_number} because exact room mapping was unclear."


def save_bytes_image(image_bytes, output_dir, filename):
    ensure_dir(output_dir)
    path = os.path.join(output_dir, filename)
    with open(path, "wb") as image_file:
        image_file.write(image_bytes)
    return path


def render_page_image(page, output_dir, filename, zoom=1.8):
    ensure_dir(output_dir)
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
    path = os.path.join(output_dir, filename)
    pix.save(path)
    return path


def extract_embedded_images(page, doc, output_dir, prefix, min_size=6000):
    ensure_dir(output_dir)
    images = []
    seen = set()
    for index, image_info in enumerate(page.get_images(full=True), start=1):
        xref = image_info[0]
        extracted = doc.extract_image(xref)
        image_bytes = extracted.get("image")
        if not image_bytes or len(image_bytes) < min_size:
            continue
        digest = hashlib.md5(image_bytes).hexdigest()
        if digest in seen:
            continue
        seen.add(digest)
        extension = extracted.get("ext", "png")
        filename = f"{prefix}-embedded-{index}.{extension}"
        path = save_bytes_image(image_bytes, output_dir, filename)
        images.append({"path": path, "filename": filename, "byteSize": len(image_bytes), "xref": xref})
    return images


def parse_summary_pairs(text):
    pattern = re.compile(
        r"(\d+)\s+(Observed .*? Flat No\. 103)\s+(\d+\.\d+)\s+(Observed .*?(?:Flat No\. 103|Flat No\. 203))",
        re.IGNORECASE,
    )
    return [
        {
            "pointNo": int(match.group(1)),
            "negativeObservation": normalize_spaces(match.group(2)),
            "positiveObservation": normalize_spaces(match.group(4)),
        }
        for match in pattern.finditer(text)
    ]


def parse_impacted_areas(text):
    pattern = re.compile(
        r"Impacted Area\s+(\d+)\s+Negative side Description\s+(.*?)\s+Negative side photographs\s+"
        r"(?:.*?\s+)?Positive side Description\s+(.*?)\s+Positive side photographs",
        re.IGNORECASE,
    )
    impacted = {}
    for match in pattern.finditer(text):
        impacted[int(match.group(1))] = {
            "negativeDescription": normalize_spaces(match.group(2)),
            "positiveDescription": normalize_spaces(match.group(3)),
        }
    return impacted


def parse_thermal_pages(pages):
    thermal = []
    for page in pages:
        text = page["text"].replace("\x00", "")
        hotspot = re.search(r"Hotspot\s*:\s*([0-9.]+)\s*[^0-9A-Za-z]?C", text)
        coldspot = re.search(r"Coldspot\s*:\s*([0-9.]+)\s*[^0-9A-Za-z]?C", text)
        source_name = re.search(r"Thermal image\s*:\s*([A-Z0-9_.-]+)", text)
        hotspot_value = float(hotspot.group(1)) if hotspot else None
        coldspot_value = float(coldspot.group(1)) if coldspot else None
        spread = round(hotspot_value - coldspot_value, 2) if hotspot_value is not None and coldspot_value is not None else None
        thermal.append(
            {
                "page": page["page"],
                "sourceName": source_name.group(1) if source_name else f"Thermal page {page['page']}",
                "hotspotC": hotspot_value if hotspot_value is not None else "Not Available",
                "coldspotC": coldspot_value if coldspot_value is not None else "Not Available",
                "spreadC": spread if spread is not None else "Not Available",
                "possibleMoistureIndicator": bool(spread is not None and (spread >= 4.5 or coldspot_value <= 22.0)),
            }
        )
    return thermal


def severity_for_text(text):
    lowered = text.lower()
    if "leakage" in lowered or "seepage" in lowered or "efflorescence" in lowered:
        return "High", "Active leakage, seepage, or salt deposits suggest a more advanced moisture issue."
    if "crack" in lowered or "dampness" in lowered or "tile joint" in lowered:
        return "Medium", "Visible dampness, cracks, or open tile joints point to a recurring issue that needs repair."
    return "Low", "Only limited evidence is available in the source documents."


def recommended_actions(text):
    lowered = text.lower()
    actions = []
    if "tile joint" in lowered or "hollowness" in lowered:
        actions.append("Open and re-grout the affected tile joints and check for hollow or loose tiles.")
    if "plumbing" in lowered or "leakage" in lowered:
        actions.append("Inspect nearby plumbing lines and fittings, then repair leaking joints before surface restoration.")
    if "external wall" in lowered or "crack" in lowered:
        actions.append("Seal external wall cracks and recheck nearby service penetrations for water ingress paths.")
    if "dampness" in lowered or "seepage" in lowered or "efflorescence" in lowered:
        actions.append("Dry the affected substrate fully, remove damaged finishes, and repaint only after moisture stabilizes.")
    return actions or ["Carry out a focused site inspection because the available evidence is incomplete."]


def dedupe_preserve(items):
    seen = set()
    result = []
    for item in items:
        key = normalize_spaces(item).lower()
        if not key or key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


def load_pdf_pages(pdf_path, image_root, document_type):
    doc = fitz.open(pdf_path)
    pages = []
    mapping_entries = []
    for idx in range(doc.page_count):
        page = doc.load_page(idx)
        page_number = idx + 1
        text = normalize_spaces(page.get_text("text"))
        inferred_areas = infer_areas(text)
        keyword_mapped = inferred_areas != ["Page-level"]
        extracted_images = extract_embedded_images(page, doc, image_root, f"page-{page_number}")
        photo_mentions = len(re.findall(r"Photo\s+\d+", text, re.IGNORECASE))
        keep_page_render = document_type == "inspection" and (not extracted_images or photo_mentions >= 4)

        if keep_page_render:
            filename = f"page-{page_number}-render.png"
            rendered_path = render_page_image(page, image_root, filename)
            extracted_images.append({"path": rendered_path, "filename": filename, "byteSize": 0, "xref": None, "isPageRender": True})

        image_records = []
        for image in extracted_images:
            is_page_render = bool(image.get("isPageRender"))
            method = "keyword" if keyword_mapped else "page-level"
            if is_page_render:
                method = "page-level" if not keyword_mapped else "keyword"
            record = {
                "path": image["path"].replace("\\", "/"),
                "relativePath": image["path"].replace("\\", "/"),
                "page": page_number,
                "documentType": document_type,
                "evidenceType": "page-render" if is_page_render else "embedded-image",
                "assignedAreas": inferred_areas,
                "mappingMethod": method,
                "mappingReason": build_mapping_reason(text, page_number, inferred_areas, method),
                "textSnippet": text[:240] if text else "Not Available",
            }
            image_records.append(record)
            mapping_entries.append(record)

        pages.append(
            {
                "page": page_number,
                "text": text,
                "areas": inferred_areas,
                "imageCount": len(image_records),
                "images": image_records,
                "pageLevelOnly": all(image["evidenceType"] == "page-render" for image in image_records) if image_records else True,
            }
        )
    doc.close()
    return pages, mapping_entries


def build_area_sections(summary_pairs, impacted_areas, inspection_pages, thermal_pages, mapping_entries, public_base):
    thermal_by_sequence = defaultdict(list)
    for index, entry in enumerate(thermal_pages):
        thermal_by_sequence[(index % max(len(summary_pairs), 1)) + 1].append(entry)

    area_sections = []
    for pair in summary_pairs:
        point_no = pair["pointNo"]
        impacted = impacted_areas.get(point_no, {})
        area_label_match = re.search(r"of\s+(.*?)\s+of Flat", pair["negativeObservation"], re.IGNORECASE)
        area_label = area_label_match.group(1).strip() if area_label_match else f"Area {point_no}"
        area_label = re.sub(r"^the\s+", "", area_label, flags=re.IGNORECASE)
        canonical_areas = [area for area in infer_areas(area_label) if area != "Page-level"] or ["External"]

        inspection_images = [
            item for item in mapping_entries
            if item["documentType"] == "inspection" and any(area in item["assignedAreas"] for area in canonical_areas)
        ]

        thermal_image_entries = []
        for thermal_page in thermal_by_sequence.get(point_no, []):
            related = [
                item for item in mapping_entries
                if item["documentType"] == "thermal" and item["page"] == thermal_page["page"]
            ]
            if not related:
                related = [{
                    "path": None,
                    "page": thermal_page["page"],
                    "evidenceType": "not-available",
                    "assignedAreas": canonical_areas,
                    "mappingMethod": "sequence",
                    "mappingReason": "Image Not Available",
                }]
            for item in related:
                cloned = dict(item)
                cloned["mappingMethod"] = "sequence" if item.get("mappingMethod") == "page-level" else item.get("mappingMethod", "sequence")
                cloned["mappingReason"] = build_mapping_reason("", thermal_page["page"], canonical_areas, cloned["mappingMethod"])
                cloned["thermalSummary"] = thermal_page
                thermal_image_entries.append(cloned)

        combined_images = []
        for entry in inspection_images + thermal_image_entries:
            relative_path = entry.get("relativePath", "").replace("\\", "/")
            web_path = f"{public_base}/{relative_path.split('data/', 1)[-1]}" if entry.get("path") else "Image Not Available"
            combined_images.append(
                {
                    "path": web_path,
                    "documentType": entry.get("documentType", "thermal"),
                    "evidenceType": entry.get("evidenceType", "not-available"),
                    "page": entry.get("page", "Not Available"),
                    "mappingMethod": entry.get("mappingMethod", "page-level"),
                    "mappingReason": entry.get("mappingReason", "Not Available"),
                }
            )

        if not combined_images:
            combined_images = [{
                "path": "Image Not Available",
                "documentType": "Not Available",
                "evidenceType": "not-available",
                "page": "Not Available",
                "mappingMethod": "page-level",
                "mappingReason": "Image Not Available",
            }]

        root_cause = impacted.get("positiveDescription") or pair["positiveObservation"] or "Not Available"
        severity_label, severity_reason = severity_for_text(f"{pair['negativeObservation']} {root_cause}")
        thermal_notes = []
        for thermal_page in thermal_by_sequence.get(point_no, []):
            if thermal_page["possibleMoistureIndicator"]:
                thermal_notes.append(
                    f"Thermal page {thermal_page['page']} shows a notable temperature spread (hotspot {thermal_page['hotspotC']} C, coldspot {thermal_page['coldspotC']} C)."
                )
        thermal_notes = dedupe_preserve(thermal_notes) or ["Not Available"]

        area_sections.append(
            {
                "area": area_label,
                "canonicalAreas": canonical_areas,
                "observation": f"{pair['negativeObservation']}. Supporting exposed-side finding: {pair['positiveObservation']}." + (f" Area sheet detail: {impacted.get('negativeDescription')}" if impacted.get("negativeDescription") else ""),
                "rootCause": root_cause,
                "severity": {"label": severity_label, "reasoning": severity_reason},
                "recommendedActions": recommended_actions(f"{pair['negativeObservation']} {root_cause}"),
                "thermalAssessment": thermal_notes,
                "imageEvidence": combined_images,
                "missingInformation": ["Image Not Available"] if combined_images and combined_images[0]["path"] == "Image Not Available" else [],
            }
        )
    return area_sections


def build_conflicts(area_sections):
    conflicts = []
    for area in area_sections:
        if "External" in area["canonicalAreas"] and "Bathroom" in area["canonicalAreas"]:
            conflicts.append(f"{area['area']}: moisture may involve both bathroom-side leakage and external-side ingress, so the exact source needs confirmation.")
    return dedupe_preserve(conflicts) or ["No direct contradictions were detected in the extracted documents."]


def build_report(inspection_pdf, thermal_pdf, output_path, public_base):
    output_root = Path(output_path).parent
    report_stem = Path(output_path).stem
    inspection_image_root = output_root / "inspection-images"
    thermal_image_root = output_root / "thermal-images"
    ensure_dir(str(inspection_image_root))
    ensure_dir(str(thermal_image_root))

    inspection_pages, inspection_mapping = load_pdf_pages(inspection_pdf, str(inspection_image_root), "inspection")
    thermal_pages_raw, thermal_mapping = load_pdf_pages(thermal_pdf, str(thermal_image_root), "thermal")

    full_inspection_text = normalize_spaces(" ".join(page["text"] for page in inspection_pages))
    summary_pairs = parse_summary_pairs(full_inspection_text)
    impacted_areas = parse_impacted_areas(normalize_spaces(" ".join(page["text"] for page in inspection_pages[:8])))
    thermal_pages = parse_thermal_pages(thermal_pages_raw)
    mapping_entries = inspection_mapping + thermal_mapping

    area_sections = build_area_sections(summary_pairs, impacted_areas, inspection_pages, thermal_pages, mapping_entries, public_base)
    conflicts = build_conflicts(area_sections)

    image_mapping = {
        "inspection": inspection_mapping,
        "thermal": thermal_mapping,
    }
    mapping_path = output_root / f"{report_stem.replace('-report', '')}-image-mapping.json"
    with open(mapping_path, "w", encoding="utf-8") as mapping_file:
        json.dump(image_mapping, mapping_file, indent=2)

    report = {
        "meta": {
            "title": "Detailed Diagnostic Report (DDR)",
            "generatedFrom": {"inspectionPdf": inspection_pdf, "thermalPdf": thermal_pdf},
            "imageMappingPath": f"{public_base}/{mapping_path.relative_to(output_root).as_posix()}",
            "reliability": {
                "imageStorage": "local-folders",
                "inspectionImageFolder": f"{public_base}/{inspection_image_root.relative_to(output_root).as_posix()}",
                "thermalImageFolder": f"{public_base}/{thermal_image_root.relative_to(output_root).as_posix()}",
                "notes": [
                    "Inspection pages are kept as page-level evidence when individual photo extraction is incomplete.",
                    "Images are preserved even when exact room mapping is uncertain.",
                ],
            },
        },
        "rawEvidence": {
            "inspectionPages": inspection_pages,
            "thermalPages": thermal_pages,
        },
        "propertyIssueSummary": {
            "headline": "Moisture-related issues were observed across multiple parts of the property, with repeated links to bathroom-side defects, plumbing concerns, and some external-side exposure.",
            "keyPoints": dedupe_preserve([section["observation"] for section in area_sections])[:5] or ["Not Available"],
        },
        "areaWiseObservations": area_sections,
        "missingInformation": [
            "Customer details: Not Available",
            "Property address: Not Available",
            "Room labels inside the thermal report: Not Available",
            "Exact image-to-room mapping for some pages: Not Available",
        ],
        "conflicts": conflicts,
    }

    with open(output_path, "w", encoding="utf-8") as report_file:
        json.dump(report, report_file, indent=2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--inspection", required=True)
    parser.add_argument("--thermal", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--public-base", default="/data")
    args = parser.parse_args()
    build_report(args.inspection, args.thermal, args.output, args.public_base)
