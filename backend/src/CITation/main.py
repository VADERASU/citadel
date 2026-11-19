import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from time import monotonic, time

from fastapi import (
    FastAPI,
    HTTPException,
    WebSocket,
    WebSocketException,
    WebSocketDisconnect,
    File,
    UploadFile,
    Form,
)
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from .data.utils import pdf_to_md_cascading, pdf_first_pages_text
from .data.raw_ref_to_json import PaperProcessor
from .data.process_references import process_markdown_string, parse_references
from .anomalies.gpt_relevance import (
    process_citation_mentions,
    assign_scores_to_enriched_papers,
)
from .anomalies.author_sus import build_suspicious_authors_graph
from .anomalies.detect_anomalies import find_anomalies
from .anomalies.venue_sus import detect_suspicious_venues
from .anomalies.stat_check import (
    generate_statistical_anomalies,
    pdf_to_plain_text,
    preprocess_text,
)

from .data.citation_graph_builder import extract_info, build_author_graph
from .data.grobid import (
    is_grobid_available,
    extract_references_with_grobid,
    extract_citation_mentions_with_grobid,
    extract_formula_coordinates_with_grobid,
    extract_abstract_with_grobid,
)
from . import cache, llm

logger = logging.getLogger(__name__)

# =============================================================================
# DEBUGGING: Output directory for debug files
# =============================================================================
DEBUG_OUTPUT_DIR = Path("outputs/debug")
f = Path(__file__)
this_dir = f.parent


# =============================================================================
# DEBUGGING: Pipeline step tracker for API call monitoring
# Tracks duration and details for each pipeline step
# =============================================================================
class PipelineTracker:
    """DEBUGGING: Tracks pipeline steps, durations, and API call counts."""

    def __init__(self):
        self.steps = []
        self.start_time = time()

    def record(self, step_name: str, duration: float, details: dict = None):
        """DEBUGGING: Record a pipeline step with timing and optional details."""
        self.steps.append(
            {
                "step": step_name,
                "duration_seconds": round(duration, 2),
                "details": details or {},
            }
        )

    def get_summary(self):
        """DEBUGGING: Get summary of all pipeline steps."""
        return {
            "total_time_seconds": round(time() - self.start_time, 2),
            "steps": self.steps,
        }


# =============================================================================
# DEBUGGING: Save all pipeline outputs to JSON files for inspection
# =============================================================================
def save_debug_outputs(
    enriched_papers,
    citations,
    authors,
    venues,
    anomalous_data,
    author_graph,
    reference_mentions,
    tracker_summary=None,
    md_text=None,
    pdf_contents=None,
    formula_coords=None,
):
    """DEBUGGING: Save all pipeline outputs to JSON files for debugging."""
    DEBUG_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    md_filepath = DEBUG_OUTPUT_DIR / "paper_markdown.md"
    if md_text is not None:
        with open(md_filepath, "w", encoding="utf-8") as f:
            f.write(md_text)
    else:
        # Avoid leaving stale markdown from a previous run masquerading as current.
        md_filepath.unlink(missing_ok=True)

    if pdf_contents is not None:
        plain_text = preprocess_text(pdf_to_plain_text(pdf_contents))
        (DEBUG_OUTPUT_DIR / "paper_plain_text.txt").write_text(plain_text, encoding="utf-8")

    outputs = {
        "enriched_papers.json": enriched_papers,
        "citations.json": list(citations.values())
        if isinstance(citations, dict)
        else citations,
        "authors.json": authors,
        "venues.json": venues,
        "anomalous.json": anomalous_data,
        "author_graph.json": author_graph,
        "reference_mentions.json": reference_mentions,
    }

    # DEBUGGING: Add pipeline tracking summary if available
    if tracker_summary:
        outputs["pipeline_summary.json"] = tracker_summary
    if formula_coords:
        outputs["formula_coords.json"] = formula_coords

    for filename, data in outputs.items():
        filepath = DEBUG_OUTPUT_DIR / filename
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
    logger.debug("Saved pipeline outputs to %s", DEBUG_OUTPUT_DIR)


def extract_references_grobid_with_fallback(
    pdf_content: bytes,
    gpt_client,
    progress_fn,
):
    """
    Extract references using grobid if available, otherwise fall back to
    markdown parsing + GPT.

    Args:
        pdf_content: Raw PDF bytes
        gpt_client: CreateAI (OpenAI-compatible) client for LLM parsing fallback
        progress_fn: Function to report progress

    Returns:
        Tuple of (parsed_references, reference_mentions, md_text or None)
    """
    use_grobid = is_grobid_available()
    md_text = None  # Only create markdown if needed

    if use_grobid:
        progress_fn("info", "Extracting the bibliography and in-text citations…")
        try:
            # Run the fulltext call first so we can harvest a xml:id → PDF
            # label map from the in-text <ref> markers, then feed it into
            # the references call. The map anchors bibliography ref_ids to
            # the source PDF numbering when GROBID drops a non-publication
            # biblStruct entry (which leaves the survivors unlabelled and
            # shifts the enumerate-index fallback by one).
            reference_mentions, label_map = extract_citation_mentions_with_grobid(
                pdf_content
            )
            parsed_refs, _ = extract_references_with_grobid(
                pdf_content, label_map=label_map
            )
            if parsed_refs:
                # If grobid didn't get good citation context, fall back to markdown parsing
                if not reference_mentions:
                    progress_fn(
                        "info", "Searching the PDF text for citation contexts…"
                    )
                    md_text = pdf_to_md_cascading(pdf_content)
                    reference_mentions, _ = process_markdown_string(md_text)

                return parsed_refs, reference_mentions, md_text
            else:
                progress_fn(
                    "warning", "The primary extractor found no bibliography entries. Trying an alternate method."
                )
        except Exception:
            logger.debug("Primary reference extraction failed", exc_info=True)
            progress_fn(
                "warning", "The primary reference extractor failed. Trying an alternate method."
            )

    # Fallback: markdown parsing + GPT
    if not use_grobid:
        progress_fn("warning", "The primary reference extractor is unavailable. Using PDF text instead.")
    progress_fn("info", "Reading the PDF text…")
    md_text = pdf_to_md_cascading(pdf_content)

    progress_fn("info", "Finding bibliography entries and in-text citations…")
    reference_mentions, raw_references = process_markdown_string(md_text)

    if raw_references:
        progress_fn("info", "Parsing bibliography entries…")
    parsed_refs = parse_references(gpt_client, raw_references, progress_fn)
    if len(parsed_refs) < len(raw_references):
        progress_fn(
            "warning",
            f"Parsed {len(parsed_refs)} of {len(raw_references)} bibliography entries from the PDF text.",
        )

    return parsed_refs, reference_mentions, md_text


if not llm.has_token():
    logger.error("Required environment variable %s is not set", llm.TOKEN_ENV)
    sys.exit(1)

app = FastAPI()
frontend_port = int(os.getenv("FRONTEND_PORT", "13001"))

# Add CORS middleware for frontend API calls
app.add_middleware(
    CORSMiddleware,
    allow_origins=[f"http://localhost:{frontend_port}", f"http://127.0.0.1:{frontend_port}"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.websocket("/ws/process_pdf")
async def process_pdf_ws(ws: WebSocket):
    await ws.accept()
    try:
        paper_metadata = await ws.receive_json()
        file_metadata = await ws.receive_json()
        contents = await ws.receive_bytes()

        if file_metadata["mime_type"] != "application/pdf":
            raise WebSocketException(code=1003, reason="Only PDF files are allowed.")

        missing_key = None
        if not llm.has_token():
            missing_key = llm.TOKEN_ENV
        elif not os.getenv("S2_API_KEY"):
            missing_key = "S2_API_KEY (Semantic Scholar)"
        if missing_key:
            await ws.send_json(
                {
                    "type": "error",
                    "msg": f"Backend is missing required environment variable: {missing_key}.",
                    "data": None,
                }
            )
            await ws.close(code=1011)
            return

        updates = asyncio.Queue()
        loop = asyncio.get_running_loop()
        active = True
        last_update = float("-inf")

        def progress(msg_type: str, msg: str):
            nonlocal last_update
            if not active:
                return

            now = monotonic()
            if msg_type == "info":
                last_update = float("-inf")
            elif msg_type == "progress":
                if now - last_update < 0.2:
                    return
                last_update = now

            # Worker threads must wake the event loop when enqueueing updates.
            event = {"type": msg_type, "msg": msg, "data": None}
            loop.call_soon_threadsafe(updates.put_nowait, event)

        async def run_analysis():
            try:
                results = await analyze_pdf(paper_metadata, contents, progress)
            except Exception:
                logger.exception("Paper analysis failed")
                progress("error", "Analysis failed. Please try again.")
            else:
                # Keep the result behind any updates already scheduled.
                loop.call_soon(updates.put_nowait, {"type": "end", "results": results})

        analysis = asyncio.create_task(run_analysis())
        try:
            while True:
                event = await updates.get()
                await ws.send_json(event)
                if event["type"] in ("end", "error"):
                    await ws.close(code=1000 if event["type"] == "end" else 1011)
                    break
        finally:
            active = False
            analysis.cancel()
            await asyncio.gather(analysis, return_exceptions=True)
    except WebSocketDisconnect:
        logger.debug("Analysis WebSocket disconnected")


async def analyze_pdf(paper_metadata, contents, progress):
    pipeline_tracker = PipelineTracker()
    cache.reset_stats()
    progress("info", "Opening the manuscript…")
    gpt_client = llm.make_client()

    # Try grobid first, fall back to markdown+GPT
    # Markdown is only created if needed (grobid fallback); pdf_to_md_cascading
    # prefers olmocr and falls back to pymupdf4llm.
    t0 = time()
    parsed, reference_mentions, md_text = await asyncio.to_thread(
        extract_references_grobid_with_fallback,
        contents,
        gpt_client,
        progress,
    )
    context_count = sum(len(mentions) for mentions in reference_mentions.values())
    pipeline_tracker.record(
        "reference_extraction",
        time() - t0,
        {"refs": len(parsed), "mentions": len(reference_mentions)},
    )
    progress(
        "summary" if parsed and context_count else "warning",
        f"Extracted {len(parsed)} bibliography entries and found {context_count} in-text citation contexts.",
    )

    progress("info", "Looking up cited papers in Semantic Scholar and OpenAlex…")

    # Enrich parsed references with Semantic Scholar / OpenAlex metadata
    processor = PaperProcessor(gpt_client=gpt_client)

    t0 = time()
    enriched, entity_keys = await asyncio.to_thread(
        processor.process_papers, parsed, reference_mentions, progress
    )
    pipeline_tracker.record(
        "enrichment_s2_openalex", time() - t0, {"papers": len(enriched)}
    )
    if parsed:
        matched = sum(
            not paper.get("could_not_find") and not paper.get("is_artificial")
            for paper in enriched.values()
        )
        progress(
            "summary" if matched == len(parsed) else "warning",
            f"Found database metadata for {matched} of {len(parsed)} bibliography entries.",
        )
    if enriched:
        missing_abstracts = sum(not paper.get("abstract") for paper in enriched.values())
        if missing_abstracts:
            progress(
                "warning",
                f"{missing_abstracts} of {len(enriched)} cited papers are missing abstracts needed for relevance checks.",
            )
        with_outbound_citations = sum(
            bool(paper.get("enriched_references")) for paper in enriched.values()
        )
        progress(
            "summary",
            f"Retrieved outbound citations for {with_outbound_citations} of {len(enriched)} cited papers.",
        )

    progress("info", "Assessing citation relevance…")

    t0 = time()
    citation_assessments = await asyncio.to_thread(
        process_citation_mentions, reference_mentions, enriched, gpt_client, progress
    )
    # why not just update this in process_citation_mentions?
    # or better yet, just keep these as separate objects?
    updated_enriched_papers = await asyncio.to_thread(
        assign_scores_to_enriched_papers, enriched, citation_assessments
    )
    pipeline_tracker.record(
        "relevance_assessment_gpt",
        time() - t0,
        {"assessments": len(citation_assessments)},
    )
    if context_count:
        scored = sum(
            mention.get("relevance_score") is not None
            for paper in updated_enriched_papers.values()
            for mention in paper.get("reference_mentions") or []
        )
        progress(
            "summary" if scored == context_count else "warning",
            f"Scored {scored} of {context_count} in-text citation contexts for relevance.",
        )

    progress("info", "Building citation graphs and checking for unusual patterns…")

    t0 = time()
    citations, authors, venues = await asyncio.to_thread(
        extract_info, entity_keys, paper_metadata
    )

    # not used?
    suspicious_sccs_g, sus_hop1_sccs, sccs_info = await asyncio.to_thread(
        build_suspicious_authors_graph, authors, citations
    )

    anomalous_data = await asyncio.to_thread(
        find_anomalies, updated_enriched_papers, sus_hop1_sccs, citations
    )
    # not used?
    export_data_suspicious, export_data_hop, scc_details = await asyncio.to_thread(
        detect_suspicious_venues, citations, venues
    )

    ag = await asyncio.to_thread(build_author_graph, citations)

    # Run statistical validation using plain text extracted from PDF
    progress("info", "Checking reported statistical tests…")
    formula_coords = None
    if await asyncio.to_thread(is_grobid_available):
        formula_coords = await asyncio.to_thread(
            extract_formula_coordinates_with_grobid, contents
        )

    stat_anomalies = await asyncio.to_thread(
        generate_statistical_anomalies,
        contents,
        len(anomalous_data.get("identifiedIssue", [])) + 1,
        0.01,
        formula_coords,
        progress,
    )
    anomalous_data["identifiedIssue"].extend(stat_anomalies)
    progress("info", "Preparing the analysis results…")

    # Set has_issue / id / cite_positions on citations based on anomalies.
    # cite_positions is one record per [N] marker in the body of the
    # manuscript; the frontend uses it to draw colored boxes around the
    # marker glyphs themselves, not around the surrounding sentence.
    anomalous_citation_keys = set()
    paper_to_issues: dict[str, list[str]] = {}
    for issue in anomalous_data.get("identifiedIssue", []):
        for paper_key in issue.get("paper", []):
            anomalous_citation_keys.add(paper_key)
            paper_to_issues.setdefault(paper_key, []).append(issue["id"])

    for citation_key, citation in citations.items():
        citation["id"] = citation_key
        citation["has_issue"] = citation_key in anomalous_citation_keys

        issues_for_paper = paper_to_issues.get(citation_key, [])
        positions: list[dict] = []
        for mention in citation.get("reference_mentions", []) or []:
            for occ in mention.get("occurrences", []) or []:
                positions.append(
                    {
                        "page": occ.get("page"),
                        "bbox": occ.get("marker_bbox"),
                        "page_width": occ.get("page_width"),
                        "page_height": occ.get("page_height"),
                        "ref_label": occ.get("ref_label"),
                        "has_issue": bool(issues_for_paper),
                        "issues": list(issues_for_paper),
                    }
                )
        citation["cite_positions"] = positions

    pipeline_tracker.record(
        "build_graphs_and_anomalies",
        time() - t0,
        {"anomalies": len(anomalous_data.get("identifiedIssue", []))},
    )

    cache_stats = cache.stats()
    pipeline_tracker.record("cache", 0, cache_stats)
    logger.debug("Cache statistics: %s", cache_stats)

    # debugging: save debug outputs including pipeline summary
    await asyncio.to_thread(
        save_debug_outputs,
        updated_enriched_papers,
        citations,
        authors,
        venues,
        anomalous_data,
        ag,
        reference_mentions,
        tracker_summary=pipeline_tracker.get_summary(),
        md_text=md_text,
        pdf_contents=contents,
        formula_coords=formula_coords,
    )

    return {
        "authors": authors,
        "venues": venues,
        "citations": list(citations.values()),
        "anomalous": anomalous_data,
        "authorGraph": ag,
    }


def _extract_metadata_with_gpt(gpt_client, first_page_text: str) -> dict:
    """Ask GPT for the manuscript's own title/authors/year from its first page."""
    prompt = (
        "Extract the manuscript metadata from the first-page text below. "
        "Return ONLY a JSON object with keys: title (string), authors (array of strings, "
        "full names in order, no affiliations or emails), year (integer or null if absent). "
        "If a field cannot be confidently determined, use null (or an empty array for authors).\n\n"
        "First-page text:\n-----\n"
        f"{first_page_text[:6000]}\n-----"
    )
    content = llm.chat(
        gpt_client,
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
        temperature=0,
    )
    result = json.loads(content)
    return {
        "title": result.get("title") or "",
        "authors": [
            a for a in (result.get("authors") or []) if isinstance(a, str) and a.strip()
        ],
        "year": result.get("year"),
    }


@app.post("/api/extract_metadata")
async def extract_paper_metadata(file: UploadFile = File(...)):
    """Extract the manuscript's title, authors, and year from its first page.

    Frontend calls this on PDF upload to pre-fill the metadata form; users can
    still review and override before submitting for analysis.
    """
    if file.content_type and file.content_type != "application/pdf":
        raise HTTPException(status_code=415, detail="Only PDF files are accepted.")

    contents = await file.read()

    try:
        first_page_text = await asyncio.to_thread(pdf_first_pages_text, contents, 2)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Could not read PDF: {e}")

    if not first_page_text.strip():
        return {"title": "", "authors": [], "year": None}

    gpt_client = llm.make_client()
    try:
        metadata = await asyncio.to_thread(
            _extract_metadata_with_gpt, gpt_client, first_page_text
        )
    except Exception as e:
        logger.debug("metadata extraction failed: %s", e)
        raise HTTPException(status_code=502, detail="Metadata extraction failed.")

    return metadata


@app.post("/api/extract_abstract")
async def extract_abstract_from_pdf(
    file: UploadFile = File(...),
    citation_id: str = Form(...),
):
    """
    Extract abstract from a PDF file using GROBID.
    Used when a referenced paper is missing its abstract.

    Args:
        file: PDF file upload
        citation_id: ID of the citation to update

    Returns:
        Dict with citation_id, abstract, title, authors
    """
    if not is_grobid_available():
        raise HTTPException(
            status_code=503,
            detail="GROBID service is not available. Please start GROBID first.",
        )

    contents = await file.read()

    result = await asyncio.to_thread(extract_abstract_with_grobid, contents)

    if result is None:
        raise HTTPException(
            status_code=422,
            detail="Could not extract abstract from PDF. The PDF may not have an abstract section.",
        )

    return {
        "citation_id": citation_id,
        "abstract": result.get("abstract"),
        "title": result.get("title"),
        "authors": result.get("authors", []),
    }


@app.post("/api/extract_abstracts")
async def extract_abstracts_batch(
    files: list[UploadFile] = File(...),
    citation_ids: str = Form(...),  # Comma-separated citation IDs
):
    """
    Extract abstracts from multiple PDFs using GROBID.
    Accepts multipart form data with multiple files and comma-separated citation IDs.

    Args:
        files: List of PDF file uploads
        citation_ids: Comma-separated citation IDs matching the files order

    Returns:
        Dict with results for each citation
    """
    if not is_grobid_available():
        raise HTTPException(
            status_code=503,
            detail="GROBID service is not available. Please start GROBID first.",
        )

    ids = citation_ids.split(",")

    if len(files) != len(ids):
        raise HTTPException(
            status_code=400,
            detail=f"Number of files ({len(files)}) doesn't match number of citation IDs ({len(ids)})",
        )

    results = []

    for file, cid in zip(files, ids):
        contents = await file.read()
        logger.debug(
            "Processing file '%s' (%s bytes) for citation %s",
            file.filename,
            len(contents),
            cid,
        )

        if len(contents) == 0:
            logger.debug("Warning - file '%s' is empty!", file.filename)
            results.append(
                {
                    "citation_id": cid.strip(),
                    "abstract": None,
                    "success": False,
                    "error": "Empty file received",
                }
            )
            continue

        result = await asyncio.to_thread(extract_abstract_with_grobid, contents)

        if result and result.get("abstract"):
            results.append(
                {
                    "citation_id": cid.strip(),
                    "abstract": result.get("abstract"),
                    "title": result.get("title"),
                    "authors": result.get("authors", []),
                    "success": True,
                }
            )
        else:
            results.append(
                {
                    "citation_id": cid.strip(),
                    "abstract": None,
                    "success": False,
                    "error": "Could not extract abstract from PDF",
                }
            )

    return {
        "results": results,
        "total": len(results),
        "successful": sum(1 for r in results if r["success"]),
    }


from starlette.exceptions import HTTPException as StarletteHTTPException


class SPAStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        try:
            return await super().get_response(path, scope)
        except StarletteHTTPException as ex:
            if ex.status_code == 404:
                # If file not found, serve index.html and let front-end router handle it
                return await super().get_response("index.html", scope)
            raise ex


def _find_frontend_build() -> Path | None:
    """Locate the production React build, if one exists.

    Checked in order: $FRONTEND_BUILD_DIR, the repo-root ``build/`` that
    ``npm run build`` produces, and a ``build/`` copied next to this module.
    """
    candidates = []
    if env_dir := os.environ.get("FRONTEND_BUILD_DIR"):
        candidates.append(Path(env_dir))
    candidates += [this_dir.parents[2] / "build", this_dir / "build"]
    for candidate in candidates:
        if (candidate / "index.html").is_file():
            return candidate
    return None


# Serve the built frontend when available. In development the React dev
# server (`npm start`) serves the UI instead, so no build is required.
_frontend_build = _find_frontend_build()
if _frontend_build is not None:
    app.mount(
        "/",
        SPAStaticFiles(directory=_frontend_build),
        name="ReviewerApp-demo",
    )
else:
    # API-only (development): editors like VS Code offer to open this port in
    # a browser, so point people at the React dev server instead of a 404.
    @app.get("/", include_in_schema=False)
    async def dev_root():
        return HTMLResponse(
            "<p>This is the Citadel API (development mode). "
            f'Open the app at <a href="http://localhost:{frontend_port}">'
            f"http://localhost:{frontend_port}</a>. "
            'API docs are at <a href="/docs">/docs</a>.</p>'
        )
