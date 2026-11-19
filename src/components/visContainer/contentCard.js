const getDoiUrl = (doi) => {
  if (!doi) return null;
  if (/^https?:\/\//i.test(doi)) return doi;
  if (/^10\.\d+\//.test(doi)) return `https://doi.org/${doi}`;
  return null;
};

export const ContentCard = ({
  issue,
  anchors,
  selection,
  setSelection,
  citation,
  author,
  venue,
  anomalousColorScheme,
}) => {
  const { category, paper, explanation } = issue;
  const color = anomalousColorScheme[issue.name].category[category.name].baseColor;
  const { anchor } = selection;
  const anchorIndex = anchors.indexOf(anchor);
  const sources = citation.filter(source => paper?.includes(source.id));
  const relatedCategories = Object.entries(category.options || {})
    .filter(([name, active]) => active && name !== category.name && anomalousColorScheme[issue.name].category[name]);
  const labels = { citationRing: "Citation Ring", selfCitation: "Self Citation", unreferenced: "Unreferenced" };

  return (
    <article className="review-detail" aria-labelledby="review-detail-title" style={{ "--finding-color": color }}>
      <div className="review-detail-heading">
        <h2 id="review-detail-title">{category.displayName}</h2>
        {anchor?.page != null && <span>Page {anchor.page}</span>}
      </div>
      {relatedCategories.length > 0 && (
        <p className="review-related">{relatedCategories.map(([name]) => labels[name] || name).join(" · ")}</p>
      )}

      {anchor && (
        <section className="review-detail-section" aria-labelledby="review-passage-title">
          <div className="review-section-heading">
            <h3 id="review-passage-title">Manuscript passage</h3>
            {anchors.length > 1 && (
              <div className="review-passage-nav" aria-label="Manuscript passages">
                <button
                  type="button"
                  aria-label="Previous passage"
                  disabled={anchorIndex <= 0}
                  onClick={() => setSelection({ issueId: issue.id, anchor: anchors[anchorIndex - 1] })}
                >‹</button>
                <span>{anchorIndex + 1} of {anchors.length}</span>
                <button
                  type="button"
                  aria-label="Next passage"
                  disabled={anchorIndex >= anchors.length - 1}
                  onClick={() => setSelection({ issueId: issue.id, anchor: anchors[anchorIndex + 1] })}
                >›</button>
              </div>
            )}
          </div>
          {anchor.sentence ? <blockquote>{anchor.sentence}</blockquote> : <p>Passage text is unavailable.</p>}
        </section>
      )}

      {sources.map(source => {
        const doi = getDoiUrl(source.doi);
        const authors = (source.author || []).map(id => author.find(item => item.id === id)?.standardized_name).filter(Boolean);
        const venueName = venue.find(item => item.id === source.venue)?.standardized_name || source.raw_venue;
        const metadata = [authors.join(", "), venueName, source.year].filter(Boolean).join(" · ");
        return (
          <section key={source.id} className="review-detail-section review-source">
            <h3>Cited source {source.cite_number != null && `[${source.cite_number}]`}</h3>
            <p className="review-source-title">
              {doi ? <a href={doi} target="_blank" rel="noopener noreferrer">{source.title || doi}</a> : source.title}
            </p>
            {metadata && <p className="review-source-meta">{metadata}</p>}
            {source.source && <p className="review-source-meta">{source.source}</p>}
            {source.abstract && (
              <details className="review-abstract">
                <summary>Source abstract</summary>
                <p>{source.abstract}</p>
              </details>
            )}
          </section>
        );
      })}

      {explanation && (
        <section className="review-detail-section">
          <h3>Explanation</h3>
          <p className="review-explanation">{explanation}</p>
        </section>
      )}
    </article>
  );
};
