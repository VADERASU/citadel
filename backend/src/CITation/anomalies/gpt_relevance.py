import logging

from .. import llm

logger = logging.getLogger(__name__)


def assess_citation_relevance(citation_key, context_text, summary_text, client):
    """Assesses relevance using an LLM with explicit reasoning."""
    prompt = f"""
You are an expert academic researcher. Your task is to evaluate the contextual relevance of the citation {citation_key} in the provided text excerpt, and to clearly explain your reasoning.

Here is the text excerpt where {citation_key} is mentioned:
-----------------------------
{context_text}
-----------------------------

Below is the summary of the cited paper corresponding to {citation_key}:
-----------------------------
{summary_text}
-----------------------------

Instructions:
1. First, decide if this mention is substantive (i.e., the text engages with the paper’s content, methods, or results) or if it is merely a bibliographic reference.
2. If the excerpt is only a reference list entry (just publication details with no discussion), then:
   - Output Score: 0
   - Explanation: "Reference list entry with no substantive discussion."
3. If the mention is substantive, rate its relevance on a scale from 1 to 10 using these guidelines:
   - 10: The text provides a detailed, direct discussion of the paper’s methods and results.
   - 7-9: The text contains an important contextual reference that significantly influences the discussion.
   - 4-6: The text offers general background information about the paper.
   - 1-3: The mention is peripheral or only minimally discussed.
4. In your response, first provide the Score and then give a detailed Explanation that explicitly states the evidence and reasoning behind your score. Mention key phrases or elements from both the excerpt and the paper summary that informed your judgment.

Please provide your answer in exactly the following format:
Score: [number]
Explanation: [Your detailed 2-3 sentence analysis, including key evidence and reasoning]
"""
    # why not return the data as a json or something to make parsing easier later?
    return llm.chat(
        client,
        messages=[{"role": "user", "content": prompt}],
        max_tokens=200,
        temperature=0.2,
        top_p=0.95,
    )


def process_citation_mentions(citation_mentions, enriched, client, progress_fn=None):
    """Process each citation mention individually, skipping if no summary is available."""
    eligible = []
    for ref_number, text_excerpts in citation_mentions.items():
        citation_key = str(ref_number)
        cited_paper = enriched.get(citation_key) or enriched.get(int(ref_number))
        if cited_paper and cited_paper.get("abstract"):
            eligible.append((citation_key, cited_paper["abstract"], text_excerpts))

    total = sum(len(excerpts) for _, _, excerpts in eligible)
    current = 0
    assessments = {}
    for citation_key, summary_text, text_excerpts in eligible:
        citation_assessments = []
        for mention in text_excerpts:
            # Older inputs store only the excerpt text.
            if isinstance(mention, dict):
                text = mention.get("text", "")
                page = mention.get("page", 1)
            else:
                text = mention
                page = 1

            current += 1
            if progress_fn:
                progress_fn("progress", f"Assessing citation context {current} of {total}.")
            try:
                assessment = assess_citation_relevance(
                    citation_key, text, summary_text, client
                )
                if not assessment:
                    raise ValueError("Empty relevance assessment")
                citation_assessments.append(
                    {"excerpt": text, "page": page, "assessment": assessment}
                )
            except Exception as e:
                logger.debug(
                    "Relevance assessment failed for reference %s: %s", citation_key, e
                )
                citation_assessments.append(
                    {
                        "excerpt": text,
                        "page": page,
                        "assessment": "Assessment failed",
                        "error": str(e),
                    }
                )

        assessments[citation_key] = citation_assessments

    return assessments


def assign_scores_to_enriched_papers(enriched_papers, citation_assessments):
    """Assign relevance scores to the reference_mentions in enriched_papers.json.

    Keyed by (citation_key, excerpt) so the same paragraph can carry
    different per-ref pages — e.g. an intro paragraph cites [21] on page 1
    and [3] on page 2; a text-only key would collapse those into one page.
    Preserves the original mention dict (including ``occurrences``) so
    downstream anchor resolution can still see every marker.
    """
    assessment_lookup = {}
    for citation_key, assessments in citation_assessments.items():
        for assessment in assessments:
            excerpt = assessment["excerpt"]
            assessment_lookup[(str(citation_key), excerpt)] = {
                "assessment": assessment["assessment"],
                "page": assessment.get("page", 1),
            }

    for ref_id, paper in enriched_papers.items():
        if "reference_mentions" in paper and paper["reference_mentions"]:
            updated_mentions = []
            for mention in paper["reference_mentions"]:
                if isinstance(mention, dict):
                    base = dict(mention)
                    mention_text = base.get("text", "")
                    mention_page = base.get("page", 1)
                else:
                    base = {"text": mention, "page": 1}
                    mention_text = mention
                    mention_page = 1

                lookup_key = (str(ref_id), mention_text)
                if lookup_key in assessment_lookup:
                    assessment_data = assessment_lookup[lookup_key]
                    assessment_text = assessment_data["assessment"]
                    try:
                        score_line = assessment_text.split("\n")[0]
                        score = int(score_line.split(": ")[1])
                    except (IndexError, ValueError):
                        logger.debug("Could not parse a relevance score for reference %s", ref_id)
                        score = None

                    base["page"] = mention_page
                    base["relevance_score"] = score
                    base["assessment"] = assessment_text
                    updated_mentions.append(base)
                else:
                    base["page"] = mention_page
                    base["relevance_score"] = None
                    base["assessment"] = "No assessment available"
                    updated_mentions.append(base)
            paper["reference_mentions"] = updated_mentions

    return enriched_papers
