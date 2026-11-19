import { findTextInLayer } from "./pdfUtil";

// GROBID uses PDF points, with US Letter as the default when dimensions are absent.
export const getMarkerRect = (anchor, pageRect) => {
  const box = anchor.marker_bbox || anchor.bbox;
  if (!box || box.x == null || box.y == null || !(box.width > 0 && box.height > 0)) {
    return null;
  }

  const xScale = pageRect.width / (anchor.page_width || 612);
  const yScale = pageRect.height / (anchor.page_height || 792);
  return {
    x: box.x * xScale,
    y: box.y * yScale,
    width: box.width * xScale,
    height: box.height * yScale,
  };
};

export const getReviewAnchors = (issue, citations) => {
  const anchors = (issue.anchors || []).filter(anchor => anchor?.page != null);
  if (anchors.length) return anchors;

  // Older results may only have citation positions, with no sentence anchors.
  return citations
    .filter(citation => issue.paper?.includes(citation.id))
    .flatMap(citation => (citation.cite_positions || [])
      .filter(position => position.page != null && position.issues?.includes(issue.id)));
};

export const resolveReviewAnchor = (anchor, layer, pageRect, includePassage = false) => {
  const box = getMarkerRect(anchor, pageRect);
  const passage = includePassage || !box
    ? findTextInLayer(layer, anchor.sentence, pageRect, box, true)
    : [];
  const marker = box ? [box] : findTextInLayer(layer, anchor.ref_label, pageRect, passage[0]);

  // A text-only anchor uses its first line as the marker.
  return { marker: marker.length ? marker : passage.slice(0, 1), passage };
};

const overlaps = (a, b) => {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0.5 && height >= 0.5 * Math.min(a.height, b.height);
};

export const groupReviewMarkers = (entries, layer, pageRect) => {
  const groups = [];
  for (const entry of entries) {
    const { marker } = resolveReviewAnchor(entry.anchor, layer, pageRect);
    if (!marker.length) continue;

    const rect = marker[0];
    const group = groups.find(group => overlaps(group.rect, rect));
    if (group) {
      group.entries.push(entry);
      const x = Math.min(group.rect.x, rect.x);
      const right = Math.max(group.rect.x + group.rect.width, rect.x + rect.width);
      group.rect = { ...group.rect, x, width: right - x };
    } else {
      const key = [rect.x, rect.y, rect.width, rect.height].join(",");
      groups.push({ key, rect, entries: [entry] });
    }
  }
  return groups;
};
