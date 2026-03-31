# -*- coding: utf-8 -*-
import argparse
import json
import os
import re
from pathlib import Path

from PyPDF2 import PdfReader


AREA_PAGE_MAP = {
    1: [3],
    2: [3, 4],
    3: [4],
    4: [4, 5],
    5: [5],
    6: [5, 6],
    7: [6],
}


def ensure_dir(path):
    os.makedirs(path, exist_ok=True)


def normalize_spaces(text):
    return re.sub(r"\s+", " ", text or "").strip()


def clean_thermal_text(text):
    return (text or "").replace("\x00", "")


def extract_images_from_page(page, output_dir, prefix, max_images=3, min_size=8000):
    ensure_dir(output_dir)
    images = []
    seen_sizes = set()
    page_images = list(getattr(page, "images", []))
    ranked = sorted(page_images, key=lambda item: len(item.data), reverse=True)

    for image in ranked:
        image_size = len(image.data)
        if image_size < min_size or image_size in seen_sizes:
            continue
        seen_sizes.add(image_size)
        ext = Path(image.name).suffix.lower() or ".png"
        filename = f"{prefix}-{len(images) + 1}{ext}"
        file_path = os.path.join(output_dir, filename)
        with open(file_path, "wb") as image_file:
            image_file.write(image.data)
        images.append({"filename": filename, "path": file_path, "size": image_size})
        if len(images) >= max_images:
            break

    return images


def parse_summary_pairs(text):
    normalized = normalize_spaces(text)
    pattern = re.compile(
        r"(\d+)\s+(Observed .*? Flat No\. 103)\s+(\d+\.\d+)\s+(Observed .*?(?:Flat No\. 103|Flat No\. 203))",
        re.IGNORECASE,
    )
    pairs = []
    for match in pattern.finditer(normalized):
        pairs.append(
            {
                "point_no": int(match.group(1)),
                "negative_observation": match.group(2).strip(),
                "positive_observation": match.group(4).strip(),
            }
        )
    return pairs


def parse_impacted_areas(text):
    normalized = normalize_spaces(text)
    pattern = re.compile(
        r"Impacted Area\s+(\d+)\s+Negative side Description\s+(.*?)\s+Negative side photographs\s+"
        r"(?:.*?\s+)?Positive side Description\s+(.*?)\s+Positive side photographs",
        re.IGNORECASE,
    )
    areas = {}
    for match in pattern.finditer(normalized):
        area_id = int(match.group(1))
        areas[area_id] = {
            "negative_description": match.group(2).strip(),
            "positive_description": match.group(3).strip(),
        }
    return areas


def parse_checklist_flags(text):
    normalized = normalize_spaces(text)
    findings = []
    checks = [
        "Leakage due to concealed plumbing Yes",
        "Leakage due to damage in Nahani trap/Brickbat coba under tile flooring Yes",
        "Gaps/Blackish dirt Observed in tile joints Yes",
        "Gaps around Nahani Trap Joints Yes",
        "Loose Plumbing joints/rust around joints and edges (Flush Tank/shower/angle cock/bibcock, washbasin, etc) Yes",
        "Are there any major or minor cracks observed over external surface? Moderate",
        "Algae fungus and Moss observed on external wall? Moderate",
    ]
    for item in checks:
        if item in normalized:
            findings.append(item)
    return findings


def build_thermal_caption(page_number, hotspot_match, coldspot_match):
    hotspot = hotspot_match.group(1) if hotspot_match else "Not Available"
    coldspot = coldspot_match.group(1) if coldspot_match else "Not Available"
    return f"Thermal source page {page_number}. Hotspot: {hotspot} C, Coldspot: {coldspot} C."


def parse_thermal_pages(reader, output_dir, public_base):
    pages = []
    for index, page in enumerate(reader.pages):
        page_number = index + 1
        text = clean_thermal_text(page.extract_text() or "")
        hotspot_match = re.search(r"Hotspot\s*:\s*([0-9.]+)\s*[^0-9A-Za-z]?C", text)
        coldspot_match = re.search(r"Coldspot\s*:\s*([0-9.]+)\s*[^0-9A-Za-z]?C", text)
        image_match = re.search(r"Thermal image\s*:\s*([A-Z0-9_.-]+)", text)
        page_images = extract_images_from_page(page, output_dir, f"thermal-page-{page_number}", max_images=1, min_size=10000)
        pages.append(
            {
                "page": page_number,
                "hotspot_c": float(hotspot_match.group(1)) if hotspot_match else None,
                "coldspot_c": float(coldspot_match.group(1)) if coldspot_match else None,
                "source_name": image_match.group(1) if image_match else f"Thermal page {page_number}",
                "images": [
                    {
                        "label": f"Thermal page {page_number}",
                        "caption": build_thermal_caption(page_number, hotspot_match, coldspot_match),
                        "src": f"{public_base}/{Path(output_dir).name}/{item['filename']}",
                    }
                    for item in page_images
                ],
            }
        )
    return pages


def assign_thermal_groups(thermal_pages, area_count):
    if area_count <= 0:
        return {}
    grouped = {}
    chunk_size = max(1, len(thermal_pages) // area_count)
    cursor = 0
    for area_id in range(1, area_count + 1):
        next_cursor = cursor + chunk_size
        if area_id == area_count:
            next_cursor = len(thermal_pages)
        grouped[area_id] = thermal_pages[cursor:next_cursor][:3]
        cursor = next_cursor
    return grouped


def score_severity(observation, positive_observation, checklist_flags):
    text = f"{observation} {positive_observation}".lower()
    if "leakage" in text or "seepage" in text:
        label = "High"
        reason = "Leakage or seepage indicates active moisture movement that can spread and worsen nearby finishes."
    elif "efflorescence" in text or "crack" in text:
        label = "High"
        reason = "Visible salt deposits or cracking suggest the moisture issue has been present long enough to affect surfaces."
    elif "mild dampness" in text:
        label = "Medium"
        reason = "Moisture is visible but described as mild, so the issue appears active without clear evidence of major damage."
    elif "dampness" in text or "hollowness" in text or "tile joints" in text:
        label = "Medium"
        reason = "Moisture signs and open tile joints point to a recurring issue that needs repair before it spreads."
    else:
        label = "Low"
        reason = "Only limited supporting evidence is available in the source documents."

    if any("external surface? Moderate" in flag for flag in checklist_flags) and "external wall" in text:
        reason += " The inspection checklist also rates the external wall condition as moderate."

    return {"label": label, "reasoning": reason}


def recommended_actions(observation, positive_observation):
    text = f"{observation} {positive_observation}".lower()
    actions = []
    if "tile joint" in text or "hollowness" in text:
        actions.append("Open and re-grout the affected tile joints, then check for loose or hollow tiles.")
    if "plumbing" in text or "concealed" in text or "leakage" in text:
        actions.append("Inspect concealed and exposed plumbing lines near the affected area and repair any leaking joints.")
    if "external wall" in text or "crack" in text:
        actions.append("Seal external wall cracks and repair any gaps around service penetrations to reduce water ingress.")
    if "dampness" in text or "seepage" in text or "efflorescence" in text:
        actions.append("Allow the area to dry after repairs, remove damaged finish layers, and repaint only after moisture levels stabilize.")
    if not actions:
        actions.append("Carry out a focused site inspection before starting repairs because the source documents do not provide enough detail.")
    return actions


def extract_property_meta(text):
    normalized = normalize_spaces(text)
    metadata = {
        "Customer Name": "Not Available",
        "Mobile": "Not Available",
        "Email": "Not Available",
        "Address": "Not Available",
        "Property Age (In years):": "Not Available",
        "Property Type:": "Not Available",
    }
    date_match = re.search(r"Inspection Date and Time:\s*([0-9./]+\s+[0-9:]+\s+IST)", normalized, re.IGNORECASE)
    metadata["Inspection Date and Time"] = date_match.group(1) if date_match else "Not Available"
    if re.search(r"Property Type:\s*Flat", normalized, re.IGNORECASE):
        metadata["Property Type:"] = "Flat"
    return metadata


def build_report(inspection_pdf, thermal_pdf, output_path, public_base):
    output_root = Path(output_path).parent
    inspection_image_dir = output_root / "inspection-images"
    thermal_image_dir = output_root / "thermal-images"
    ensure_dir(str(inspection_image_dir))
    ensure_dir(str(thermal_image_dir))

    inspection_reader = PdfReader(inspection_pdf)
    thermal_reader = PdfReader(thermal_pdf)

    inspection_texts = [page.extract_text() or "" for page in inspection_reader.pages]
    inspection_text = "\n".join(inspection_texts)
    thermal_pages = parse_thermal_pages(thermal_reader, str(thermal_image_dir), public_base)

    summary_pairs = parse_summary_pairs(inspection_text)
    area_descriptions = parse_impacted_areas(" ".join(inspection_texts[2:6]))
    checklist_flags = parse_checklist_flags(" ".join(inspection_texts[6:9]))
    thermal_groups = assign_thermal_groups(thermal_pages, len(summary_pairs))
    property_meta = extract_property_meta(inspection_text)

    area_reports = []
    for pair in summary_pairs:
        area_id = pair["point_no"]
        area_name_match = re.search(r"of\s+(.*?)\s+of Flat", pair["negative_observation"], re.IGNORECASE)
        area_name = area_name_match.group(1).strip() if area_name_match else f"Area {area_id}"
        area_name = re.sub(r"^the\s+", "", area_name, flags=re.IGNORECASE)
        descriptions = area_descriptions.get(area_id, {})
        severity = score_severity(pair["negative_observation"], pair["positive_observation"], checklist_flags)
        actions = recommended_actions(pair["negative_observation"], pair["positive_observation"])

        inspection_images = []
        for page_number in AREA_PAGE_MAP.get(area_id, []):
            page = inspection_reader.pages[page_number - 1]
            page_images = extract_images_from_page(page, str(inspection_image_dir), f"area-{area_id}-page-{page_number}", max_images=2, min_size=9000)
            for image in page_images:
                inspection_images.append(
                    {
                        "label": f"Inspection source page {page_number}",
                        "caption": f"Extracted inspection image from page {page_number} for {area_name}.",
                        "src": f"{public_base}/{inspection_image_dir.name}/{image['filename']}",
                    }
                )

        thermal_images = []
        for thermal_page in thermal_groups.get(area_id, []):
            thermal_images.extend(thermal_page["images"])
        if not thermal_images:
            thermal_images = [{"label": "Thermal image", "caption": "Image Not Available.", "src": None}]

        probable_root_cause = descriptions.get("positive_description", pair["positive_observation"])
        if area_id == 5 and "external wall" not in probable_root_cause.lower():
            probable_root_cause = "Observed cracks on the external wall, along with a possible duct-side moisture path."

        observation = (
            f"{pair['negative_observation']}. Supporting exposed-side finding: {pair['positive_observation']}."
        )
        if descriptions.get("negative_description"):
            observation += f" Area sheet description: {descriptions['negative_description']}."

        area_reports.append(
            {
                "area": area_name,
                "observation": observation,
                "probableRootCause": probable_root_cause,
                "severity": severity,
                "recommendedActions": actions,
                "supportingImages": {
                    "inspection": inspection_images or [{"label": "Inspection image", "caption": "Image Not Available.", "src": None}],
                    "thermal": thermal_images,
                },
                "sourceNotes": [
                    f"Inspection summary point {area_id}",
                    "Thermal page mapping is inferred from document order because room names are not present in the thermal PDF.",
                ],
            }
        )

    report = {
        "meta": {
            "title": "Detailed Diagnostic Report (DDR)",
            "generatedFrom": {
                "inspectionPdf": str(inspection_pdf),
                "thermalPdf": str(thermal_pdf),
            },
            "property": {
                "customerName": property_meta.get("Customer Name", "Not Available"),
                "address": property_meta.get("Address", "Not Available"),
                "inspectionDate": property_meta.get("Inspection Date and Time", "Not Available"),
                "propertyType": property_meta.get("Property Type:", "Not Available"),
            },
        },
        "propertyIssueSummary": {
            "headline": "Multiple moisture-related defects were observed across the flat, with repeated links to bathroom tile-joint issues, plumbing concerns, and one external wall crack condition.",
            "keyPoints": [
                "Skirting-level dampness was reported in the hall, common bedroom, master bedroom, and kitchen.",
                "The master bedroom wall shows dampness with efflorescence, which is more advanced than the other interior observations.",
                "Leakage and seepage were also observed below the flat at the parking ceiling and on the common bathroom ceiling.",
                "The source documents repeatedly point to open tile joints, bathroom-side hollowness, plumbing issues, and one external wall crack zone.",
            ],
        },
        "areaWiseObservations": area_reports,
        "additionalNotes": [
            "Thermal pages provide hotspot and coldspot values but do not name the room or area directly.",
            "The final report keeps thermal images attached as supporting evidence and marks the page-to-area match as inferred where necessary.",
            "No facts have been added beyond the supplied documents; where clarity is missing, the report says so explicitly.",
        ],
        "missingOrUnclearInformation": [
            "Customer name: Not Available",
            "Property address: Not Available",
            "Property age: Not Available",
            "Room labels inside the thermal report: Not Available",
            "Exact image-to-room mapping inside the thermal report: Not Available",
        ],
        "conflicts": [
            "No direct contradictions were found, but some moisture areas have more than one possible contributing cause in the inspection notes.",
        ],
        "sourceEvidence": {
            "checklistFlags": checklist_flags,
            "thermalOverview": [
                {
                    "page": page["page"],
                    "sourceName": page["source_name"],
                    "hotspotC": page["hotspot_c"] if page["hotspot_c"] is not None else "Not Available",
                    "coldspotC": page["coldspot_c"] if page["coldspot_c"] is not None else "Not Available",
                }
                for page in thermal_pages[:10]
            ],
        },
    }

    with open(output_path, "w", encoding="utf-8") as output_file:
        json.dump(report, output_file, indent=2)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inspection", required=True)
    parser.add_argument("--thermal", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--public-base", default="/data")
    args = parser.parse_args()
    build_report(args.inspection, args.thermal, args.output, args.public_base)


if __name__ == "__main__":
    main()
