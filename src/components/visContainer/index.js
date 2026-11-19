import { useEffect, useCallback, useState } from "react";

import { ContentCard } from "./contentCard";
import { OverviewCard } from "./overviewCard";
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
    authorGraphDataRaw,
}) => {
    const [authorGraphData, setAuthorGraphData] = useState(null);
    const [adjacencyMatrixData, setAdjacencyMatrixData] = useState(null);

    const authorGraphDataProcess = useCallback(() => {
        if (!authorGraphDataRaw || !author) return null;
        if (!authorGraphDataRaw.nodes || !authorGraphDataRaw.links) return null;

        // add author names to author nodes
        const authorGraphDataRaw_ = JSON.parse(JSON.stringify(authorGraphDataRaw));

        // Filter nodes with groups not equal to 0
        authorGraphDataRaw_.nodes = authorGraphDataRaw_.nodes.filter(node => node.group !== 0);

        // Filter links that only contain nodes with groups not equal to 0
        const validNodeIds = new Set(authorGraphDataRaw_.nodes.map(node => node.id));
        authorGraphDataRaw_.links = authorGraphDataRaw_.links.filter(link => validNodeIds.has(link.source) && validNodeIds.has(link.target));

        // Add corresponding author name to each node
        authorGraphDataRaw_.nodes.forEach(node => {
            const authorData = author.find((a) => a.id === node.id);
            if (authorData) {
                node.name = authorData.standardized_name;
                node.has_issue = authorData.has_issue;
            }
        });

        //console.log(authorGraphDataRaw_);
        return (authorGraphDataRaw_);
    }, [authorGraphDataRaw, author]);

    const adjacencyMatrixDataProcess = useCallback(() => {
        if (!authorGraphDataRaw || !author || !citation) return null;
        if (!authorGraphDataRaw.nodes || !authorGraphDataRaw.links) return null;

        // add author names to author nodes
        const authorGraphDataRaw_ = JSON.parse(JSON.stringify(authorGraphDataRaw));

        // Map each author with their citations and filter the authors with hop in citation other than 1
        authorGraphDataRaw_.nodes = authorGraphDataRaw_.nodes.filter(node => {
            const citationData = citation.find((c) => c.author.includes(node.id));

            return citationData && citationData.hop === 1;
        });

        // Filter links that only contain nodes with groups not equal to 0
        const validNodeIds = new Set(authorGraphDataRaw_.nodes.map(node => node.id));
        authorGraphDataRaw_.links = authorGraphDataRaw_.links.filter(link => validNodeIds.has(link.source) && validNodeIds.has(link.target));

        // Add corresponding author name to each node
        authorGraphDataRaw_.nodes.forEach(node => {
            const authorData = author.find((a) => a.id === node.id);
            if (authorData) {
                node.name = authorData.standardized_name;
                node.has_issue = authorData.has_issue;
            }
        });
        //console.log(authorGraphDataRaw_);
        return (authorGraphDataRaw_);
    }, [authorGraphDataRaw, author, citation]);

    useEffect(() => {
        setAuthorGraphData(authorGraphDataProcess());
    }, [authorGraphDataProcess]);

    useEffect(() => {
        setAdjacencyMatrixData(adjacencyMatrixDataProcess());
    }, [adjacencyMatrixDataProcess]);

    const selectedIssue = anomalous.find(issue => issue.id === selection?.issueId && !issue.filter);

    return (
        <aside className="review-sidebar" aria-label="Citation review">
            <section className="review-sidebar-list" aria-labelledby="review-findings-title">
                <div className="review-sidebar-heading">
                    <h1 id="review-findings-title">Findings</h1>
                    <details className="review-overview">
                        <summary>Information overview</summary>
                        <div className="review-overview-content">
                            <OverviewCard
                                anomalous={anomalous}
                                author={author}
                                venue={venue}
                                citation={citation}
                                graphData={authorGraphData}
                                adjacencyMatrixData={adjacencyMatrixData}
                                anomalousColorScheme={anomalousColorScheme}
                            />
                        </div>
                    </details>
                </div>
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
