import "./toolbar.css";

const MIN_ZOOM = 20;
const MAX_ZOOM = 400;

export const ToolBar = ({ currentPage, numPages, zoom, onZoom }) => (
  <header className="pdf-toolbar">
    <div className="pdf-toolbar-title">
      <strong>Manuscript</strong>
      {numPages > 0 && <span>Page {currentPage} of {numPages}</span>}
    </div>
    <div className="pdf-zoom" role="group" aria-label="PDF zoom">
      <button type="button" aria-label="Zoom out" disabled={zoom <= MIN_ZOOM} onClick={() => onZoom(zoom - 10)}>−</button>
      <span aria-live="polite">{zoom}%</span>
      <button type="button" aria-label="Zoom in" disabled={zoom >= MAX_ZOOM} onClick={() => onZoom(zoom + 10)}>+</button>
      <button type="button" className="pdf-fit" onClick={() => onZoom(100)}>Fit width</button>
    </div>
  </header>
);
