import { getReviewAnchors, groupReviewMarkers, resolveReviewAnchor } from "./anomalyAnchor";

const pageRect = { left: 0, top: 0, width: 612, height: 792 };
const box = (x, width = 9) => ({ x, y: 30, width, height: 8 });

test("groups overlapping citation markers and leaves adjacent markers clickable", () => {
  const entries = [
    { issue: { id: "relevance" }, anchor: { marker_bbox: box(10) } },
    { issue: { id: "ring" }, anchor: { marker_bbox: box(10.5) } },
    { issue: { id: "adjacent" }, anchor: { marker_bbox: box(20) } },
  ];
  const groups = groupReviewMarkers(entries, null, pageRect);

  expect(groups.map(group => group.entries.map(entry => entry.issue.id))).toEqual([
    ["relevance", "ring"],
    ["adjacent"],
  ]);
});

test("uses the assessed occurrence instead of every mention of the cited paper", () => {
  const position = { page: 1, bbox: box(10), issues: ["relevance"] };
  const citation = { id: "source", cite_positions: [position] };
  const anchor = { page: 2, marker_bbox: box(20), sentence: "The claim under review." };
  const issue = { id: "relevance", paper: ["source"] };

  expect(getReviewAnchors({ ...issue, anchors: [anchor] }, [citation])).toEqual([anchor]);
  expect(getReviewAnchors(issue, [citation])).toEqual([position]);
});

test("highlights the matched characters even when the marker has its own coordinates", () => {
  const layer = document.createElement("div");
  layer.innerHTML = "<span>Previous sentence. The claim cites </span><span>[2]. Another sentence.</span>";
  const firstLine = layer.firstChild.firstChild;
  const range = jest.spyOn(document, "createRange").mockImplementation(() => {
    let startNode;
    let start;
    let end;
    return {
      setStart(node, index) {
        startNode = node;
        start = index;
      },
      setEnd(node, index) {
        end = index;
      },
      getBoundingClientRect() {
        const offset = startNode === firstLine ? 0 : firstLine.length;
        return { left: offset + start, top: 30, width: end - start, height: 8 };
      },
    };
  });

  try {
    const anchor = { marker_bbox: box(35, 3), sentence: "The claim cites [2].", ref_label: "[2]" };
    const { marker, passage } = resolveReviewAnchor(anchor, layer, pageRect, true);

    expect(marker).toEqual([box(35, 3)]);
    expect(passage).toEqual([box(19, 16), box(35, 4)]);
  } finally {
    range.mockRestore();
  }
});
