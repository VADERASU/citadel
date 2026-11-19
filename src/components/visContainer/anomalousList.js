import { useEffect, useRef } from "react";

const CATEGORY_RANK = {
  testFailure: 0,
  selfCitation: 1,
  citationRing: 2,
  unreferenced: 3,
  lowRelevancy: 4,
};

export const AnomalousListCard = ({ anomalous, citation, reviewAnchors, anomalousColorScheme, selection, setSelection }) => {
  const listRef = useRef(null);
  const itemRef = useRef(null);

  useEffect(() => {
    const list = listRef.current;
    const item = itemRef.current;
    if (!list || !item) return;

    const listBounds = list.getBoundingClientRect();
    const itemBounds = item.getBoundingClientRect();
    if (itemBounds.bottom > listBounds.bottom) {
      list.scrollTop += itemBounds.bottom - listBounds.bottom;
    } else if (itemBounds.top < listBounds.top) {
      list.scrollTop += itemBounds.top - listBounds.top;
    }
  }, [selection, anomalous]);

  const findings = anomalous.filter(issue => !issue.filter).map(issue => {
    const anchors = reviewAnchors.get(issue.id) || [];
    const pages = [...new Set(anchors.map(anchor => Number(anchor.page)))].sort((a, b) => a - b);
    if (!pages.length && issue.page != null) pages.push(issue.page);
    const refs = citation.filter(source => issue.paper?.includes(source.id) && source.cite_number != null);
    return { issue, anchors, pages, refs };
  }).sort((a, b) => (a.pages[0] ?? Infinity) - (b.pages[0] ?? Infinity) ||
    (CATEGORY_RANK[a.issue.category.name] ?? 99) - (CATEGORY_RANK[b.issue.category.name] ?? 99)
  );

  if (!findings.length) {
    return <p className="review-empty-list">{anomalous.length ? "All findings are hidden by filters." : "No anomalies detected."}</p>;
  }

  return (
    <ul className="review-findings" aria-label="Findings" ref={listRef}>
      {findings.map(({ issue, anchors, pages, refs }) => {
        const color = anomalousColorScheme[issue.name].category[issue.category.name].baseColor;
        const active = issue.id === selection?.issueId;
        return (
          <li key={issue.id}>
            <button
              type="button"
              className="review-finding"
              style={{ "--finding-color": color }}
              aria-pressed={active}
              ref={active ? itemRef : null}
              onClick={() => setSelection({
                issueId: issue.id,
                anchor: active ? selection.anchor : anchors.find(anchor => anchor.sentence) || anchors[0],
              })}
            >
              <span className="review-finding-label">
                {issue.category.displayName}
                {refs.length > 0 && <span className="review-reference"> {refs.map(ref => `[${ref.cite_number}]`).join(" ")}</span>}
              </span>
              {pages.length > 0 && (
                <span className="review-finding-page">{pages.length > 1 ? "Pages " : "Page "}{pages.join(", ")}</span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
};
