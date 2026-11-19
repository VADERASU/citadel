import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Document, Page } from "react-pdf";
import { groupReviewMarkers, resolveReviewAnchor } from "../../util/anomalyAnchor";
import { ToolBar } from "./toolbar";

import "react-pdf/dist/esm/Page/TextLayer.css";
import "./style.css";

const rectStyle = ({ x, y, width, height }) => ({ left: x, top: y, width, height });
const getColors = (scheme, issue) => scheme[issue.name]?.category?.[issue.category.name] || scheme[issue.name] || scheme.other;

const PageAnnotations = ({ layer, page, entries, selection, selectedIssue, scheme, setSelection, showSelection }) => {
  const groups = useMemo(() => groupReviewMarkers(
    entries, layer, page.parentElement.getBoundingClientRect()
  ), [entries, layer, page]);

  const anchor = selection?.anchor;
  const anchorOnPage = anchor && Number(anchor.page) === Number(page.dataset.pageNumber);
  const active = useMemo(() => anchorOnPage
    ? resolveReviewAnchor(anchor, layer, page.parentElement.getBoundingClientRect(), true)
    : null, [anchor, anchorOnPage, layer, page]);

  useLayoutEffect(() => {
    const targetPage = Number(anchor?.page ?? selectedIssue?.page);
    if (selection && targetPage === Number(page.dataset.pageNumber)) {
      showSelection(selection, page, active?.passage[0] || active?.marker[0]);
    }
  }, [selection, anchor, selectedIssue, page, active, showSelection]);

  return (
    <div className="pdf-annotations">
      {active?.passage.map((rect, index) => (
        <div
          key={index}
          className="pdf-passage-highlight"
          aria-hidden="true"
          style={{ ...rectStyle(rect), backgroundColor: getColors(scheme, selectedIssue).boxColor }}
        />
      ))}
      {groups.map(({ key, rect, entries }) => {
        const selected = entries.findIndex(entry => entry.anchor === anchor && entry.issue.id === selection?.issueId);
        const issue = entries[selected === -1 ? 0 : selected].issue;
        const colors = getColors(scheme, issue);
        const nextEntry = entries[(selected + 1) % entries.length];
        const label = [`Review ${nextEntry.issue.category.displayName}`, nextEntry.anchor.ref_label]
          .filter(Boolean).join(" ");
        return (
          <button
            key={key}
            type="button"
            className="pdf-marker"
            aria-label={label}
            aria-pressed={selected !== -1}
            title={label}
            data-category={issue.category.name}
            style={{ ...rectStyle(rect), "--marker-color": colors.baseColor }}
            onClick={() => setSelection({ issueId: nextEntry.issue.id, anchor: nextEntry.anchor })}
          />
        );
      })}
    </div>
  );
};

const EMPTY_ENTRIES = [];

const ReviewPage = ({ pageNumber, aspectRatio, width, zoom, entries, ...annotations }) => {
  const pageRef = useRef(null);
  const [ready, setReady] = useState(null);
  const onTextRender = useCallback(() => {
    const layer = pageRef.current?.querySelector(".react-pdf__Page__textContent");
    if (layer) setReady({ layer, width, zoom });
  }, [width, zoom]);

  const scaledWidth = width * zoom / 100;
  const hasTextLayer = ready?.width === width && ready.zoom === zoom && ready.layer.isConnected;
  return (
    <div
      className="pdf-page-slot"
      data-page-number={pageNumber}
      style={{ width: Math.floor(scaledWidth), height: Math.floor(scaledWidth / aspectRatio) }}
    >
      <Page
        inputRef={pageRef}
        pageNumber={pageNumber}
        width={width}
        scale={zoom / 100}
        renderAnnotationLayer={false}
        onRenderTextLayerSuccess={onTextRender}
      >
        {hasTextLayer && (
          <PageAnnotations {...annotations} layer={ready.layer} page={pageRef.current} entries={entries} />
        )}
      </Page>
    </div>
  );
};

export const PDFContainer = ({ file, anomalous, reviewAnchors, anomalousColorScheme, selection, setSelection }) => {
  const viewerRef = useRef(null);
  const shownSelection = useRef(null);
  const viewPosition = useRef(null);
  const measuredWidth = useRef(0);

  const [pageRatios, setPageRatios] = useState([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [width, setWidth] = useState(0);
  const [zoom, setZoom] = useState(100);
  const selectedIssue = anomalous.find(issue => issue.id === selection?.issueId && !issue.filter);

  const entriesByPage = useMemo(() => {
    const pages = new Map();
    anomalous.filter(issue => !issue.filter).forEach(issue => {
      for (const anchor of reviewAnchors.get(issue.id) || []) {
        const page = Number(anchor.page);
        if (!pages.has(page)) pages.set(page, []);
        pages.get(page).push({ issue, anchor });
      }
    });
    return pages;
  }, [anomalous, reviewAnchors]);

  const getPageAtViewport = useCallback(() => {
    const viewer = viewerRef.current;
    const y = viewer.getBoundingClientRect().top + viewer.clientHeight / 4;
    const pages = Array.from(viewer.querySelectorAll(".pdf-page-slot"));
    return pages.find(page => page.getBoundingClientRect().bottom >= y) || pages[pages.length - 1];
  }, []);

  const handleScroll = useCallback(() => {
    const page = getPageAtViewport();
    if (page) setCurrentPage(Number(page.dataset.pageNumber));
  }, [getPageAtViewport]);

  const saveViewPosition = useCallback(() => {
    const viewer = viewerRef.current;
    const page = getPageAtViewport();
    if (!page) return;

    const view = viewer.getBoundingClientRect();
    const rect = page.getBoundingClientRect();
    viewPosition.current = {
      page,
      x: (view.left + viewer.clientWidth / 2 - rect.left) / rect.width,
      y: (view.top + viewer.clientHeight / 4 - rect.top) / rect.height,
    };
  }, [getPageAtViewport]);

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = Math.floor(entry.contentRect.width);
      if (nextWidth <= 0 || measuredWidth.current === nextWidth) return;
      saveViewPosition();
      measuredWidth.current = nextWidth;
      setWidth(nextWidth);
    });
    observer.observe(viewerRef.current);
    return () => observer.disconnect();
  }, [saveViewPosition]);

  useLayoutEffect(() => {
    const position = viewPosition.current;
    if (!position) return;
    viewPosition.current = null;
    const viewer = viewerRef.current;
    const rect = position.page.getBoundingClientRect();
    const view = viewer.getBoundingClientRect();
    viewer.scrollBy({
      left: rect.left + position.x * rect.width - view.left - viewer.clientWidth / 2,
      top: rect.top + position.y * rect.height - view.top - viewer.clientHeight / 4,
    });
    handleScroll();
  }, [width, zoom, handleScroll]);

  const handleZoom = (nextZoom) => {
    if (nextZoom === zoom) return;
    saveViewPosition();
    setZoom(nextZoom);
  };

  const loadPageSizes = async (pdf) => {
    const ratios = await Promise.all(Array.from({ length: pdf.numPages }, async (_, index) => {
      try {
        const page = await pdf.getPage(index + 1);
        const { width, height } = page.getViewport({ scale: 1 });
        return width / height;
      } catch {
        return 612 / 792;
      }
    }));
    setPageRatios(ratios);
  };

  const showSelection = useCallback((nextSelection, page, rect) => {
    if (shownSelection.current === nextSelection) return;
    shownSelection.current = nextSelection;

    const viewer = viewerRef.current;
    const view = viewer.getBoundingClientRect();
    const pageBounds = page.getBoundingClientRect();
    const left = pageBounds.left + (rect?.x ?? 0);
    const top = pageBounds.top + (rect?.y ?? 0);
    const outsideWidth = left < view.left || left + (rect?.width ?? 0) > view.left + viewer.clientWidth;

    viewer.scrollBy({
      left: outsideWidth ? left - view.left - viewer.clientWidth / 5 : 0,
      top: top - view.top - viewer.clientHeight / 4,
    });
    setCurrentPage(Number(page.dataset.pageNumber));
  }, []);

  return (
    <section className="pdf-pane" aria-label="Manuscript">
      <ToolBar currentPage={currentPage} numPages={pageRatios.length} zoom={zoom} onZoom={handleZoom} />
      <div ref={viewerRef} className="pdf-container" onScroll={handleScroll}>
        <Document file={file} onLoadSuccess={loadPageSizes} className="pdf-document">
          {width > 0 && pageRatios.map((aspectRatio, index) => (
            <ReviewPage
              key={index + 1}
              pageNumber={index + 1}
              aspectRatio={aspectRatio}
              width={width}
              zoom={zoom}
              entries={entriesByPage.get(index + 1) || EMPTY_ENTRIES}
              selection={selectedIssue ? selection : null}
              selectedIssue={selectedIssue}
              scheme={anomalousColorScheme}
              setSelection={setSelection}
              showSelection={showSelection}
            />
          ))}
        </Document>
      </div>
    </section>
  );
};
