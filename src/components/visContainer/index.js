import { ContentCard } from "./contentCard";
import { AnomalousListCard } from "./anomalousList";

import { FloatingPanel } from "../issueComps/floatPanel";
import "./style.css";

export const VisContainer = ({
    citation,
    author,
    venue,
    anomalous,
    reviewAnchors,
    setAnomalous,
    anomalousColorScheme,
    selection,
    setSelection,
}) => {
    const selectedIssue = anomalous.find(issue => issue.id === selection?.issueId && !issue.filter);

    return (
        <aside className="review-sidebar" aria-label="Citation review">
            <section className="review-sidebar-list" aria-labelledby="review-findings-title">
                <h1 id="review-findings-title">Findings</h1>
                <FloatingPanel
                    anomalous={anomalous}
                    anomalousColorScheme={anomalousColorScheme}
                    setAnomalous={setAnomalous}
                />
                <AnomalousListCard
                    anomalous={anomalous}
                    citation={citation}
                    reviewAnchors={reviewAnchors}
                    anomalousColorScheme={anomalousColorScheme}
                    selection={selection}
                    setSelection={setSelection}
                />
            </section>
            {selectedIssue ? (
                <ContentCard
                    key={selectedIssue.id}
                    issue={selectedIssue}
                    anchors={reviewAnchors.get(selectedIssue.id) || []}
                    selection={selection}
                    setSelection={setSelection}
                    citation={citation}
                    author={author}
                    venue={venue}
                    anomalousColorScheme={anomalousColorScheme}
                />
            ) : (
                <p className="review-empty-detail">
                    {anomalous.some(issue => !issue.filter) ? "Select a finding to review its details." : ""}
                </p>
            )}
        </aside>
    );
};
