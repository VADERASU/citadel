// Function to extract text from a PDF page
export const extractTextFromPage = async (pdf, pageNumber) => {
  try {
    const page = await pdf.getPage(pageNumber);
    const textContent = await page.getTextContent();
    return textContent.items.map((item) => ({
      text: item.str,
      transform: item.transform,
      width: item.width,
      height: item.height,
      x: item.transform[4],
      y: item.transform[5],
    }));
  } catch (error) {
    console.error(`Error extracting text from page ${pageNumber}:`, error);
    return [];
  }
};

// search for the first sentence in the first section
export const findSentenceCoordinates = (textItems, sentence) => {
  const targetItem = textItems.find((item) => item.text.includes(sentence));
  if (targetItem) {
    return {
      x: targetItem.x,
      y: targetItem.y,
      width: targetItem.width,
      height: targetItem.height,
    };
  }
  return null;
};

const normalizeCharacter = (character, mode) => {
  const text = character.normalize("NFKC").toLowerCase().replace(/\u00ad/g, "");
  if (mode === "letters") return text.replace(/[^\p{L}\p{N}]/gu, "");

  const punctuation = text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[−–—]/g, "-");
  if (mode === "words") return punctuation.replace(/\s/g, " ");

  return punctuation
    .replace(/\s/g, "")
    .replace(/≤/g, "<=")
    .replace(/≥/g, ">=")
    .replace(/≠/g, "!=")
    .replace(/×/g, "x");
};

const normalizeText = (text, mode) =>
  Array.from(text, character => normalizeCharacter(character, mode))
    .join("").replace(/ +/g, " ").trim();

const indexTextLayer = (nodes, mode) => {
  let text = "";
  const offsets = [];
  nodes.forEach((node) => {
    let offset = 0;
    for (const character of node.data) {
      const start = offset;
      offset += character.length;
      const normalized = normalizeCharacter(character, mode);
      for (const unit of normalized.split("")) {
        if (unit === " " && (!text || text.endsWith(" "))) continue;
        text += unit;
        offsets.push({ node, start, end: offset });
      }
    }
    if (mode === "words") {
      if (/[\p{L}]-$/u.test(text)) {
        text = text.slice(0, -1);
        offsets.pop();
      } else if (text && !text.endsWith(" ")) {
        text += " ";
        offsets.push(null);
      }
    }
  });
  return { text, offsets };
};

const getTextNodes = (layer) =>
  Array.from(layer.querySelectorAll("span")).flatMap(span =>
    Array.from(span.childNodes).filter(node => node.nodeType === Node.TEXT_NODE && node.data.trim())
  );

const rangeRects = (offsets, origin) => {
  const range = document.createRange();
  const rects = [];
  let first;
  let last;

  const addRect = () => {
    if (!first) return;
    range.setStart(first.node, first.start);
    range.setEnd(last.node, last.end);
    const { left, top, width, height } = range.getBoundingClientRect();
    if (width > 0 && height > 0) {
      rects.push({ x: left - origin.left, y: top - origin.top, width, height });
    }
  };

  offsets.forEach((offset) => {
    if (!offset) return;
    if (offset.node !== first?.node) {
      addRect();
      first = offset;
    }
    last = offset;
  });
  addRect();
  return rects;
};

const findTextRanges = (index, target, origin, near) => {
  if (!target) return [];
  let best = [];
  let distance = Infinity;
  let start = index.text.indexOf(target);
  while (start !== -1) {
    const rects = rangeRects(index.offsets.slice(start, start + target.length), origin);
    if (rects.length) {
      if (!near) return rects;
      const candidateDistance = Math.min(...rects.map(rect => Math.hypot(
        Math.max(rect.x - near.x, near.x - rect.x - rect.width, 0),
        Math.max(rect.y - near.y, near.y - rect.y - rect.height, 0)
      )));
      if (candidateDistance < distance) {
        distance = candidateDistance;
        best = rects;
      }
    }
    start = index.text.indexOf(target, start + 1);
  }
  return best;
};

/** Find only the matched characters, including when PDF.js splits them across spans. */
export const findTextInLayer = (layer, text, origin, near = null, isPassage = false) => {
  if (!layer || !text) return [];

  // Statistical findings can include a label or document path before the formula.
  const statStart = text.search(/(?:[ft]\s*\(|p\s*[<>=]|chi[²2]?\s*\()/i);
  if (statStart > 0 && /[\\/]|\.[a-z0-9]{1,8}(?::\d+)?$|\b(?:reported|figure|fig|table|tab|equation|eq)\s*:?$/i.test(text.slice(0, statStart).trim())) {
    text = text.slice(statStart);
  }

  const nodes = getTextNodes(layer);
  const modes = isPassage ? ["words", "compact", "letters"] : ["compact"];
  for (const mode of modes) {
    const target = normalizeText(text, mode);
    if (!target || (mode === "letters" && target.length < 12)) continue;
    const index = indexTextLayer(nodes, mode);
    const rects = findTextRanges(index, target, origin, near);
    if (rects.length) return rects;

    // An excerpt that continues onto the next page can still be located by its prefix.
    if (mode === "letters") {
      for (let length = target.length - 10; length >= 40; length -= 10) {
        const prefix = findTextRanges(index, target.slice(0, length), origin, near);
        if (prefix.length) return prefix;
      }
    }
  }
  return [];
};

// Function to find the bounding box for a specific citation (e.g. "[14]") within text items
export const findCitationCoordinates = (textItems, targetCitation) => {
  const results = [];

  textItems.forEach((item) => {
    // Find the starting index of the target citation within the text item
    const index = item.text.indexOf(targetCitation);
    if (index !== -1) {
      // Estimate the average width per character
      const totalChars = item.text.length;
      if (totalChars === 0) return; // safeguard

      const charWidth = item.width / totalChars;
      // Calculate the width of the citation substring
      const citationWidth = charWidth * targetCitation.length;
      // Calculate the x-offset for the citation substring
      const citationX = item.x + (index * charWidth);

      results.push({
        citation: targetCitation,
        x: citationX,
        y: item.y,
        width: citationWidth,
        height: item.height,
      });
    }
  });

  return results;
};


export async function loadPDF(path) {
  try {
    const pdfPath = "../data/test.pdf"; // Replace 'sample.pdf' with your file name

    // Fetch the PDF file as a binary blob
    const response = await fetch(pdfPath);

    if (!response.ok) {
      throw new Error(`Failed to fetch PDF file: ${response.statusText}`);
    }

    // Read the response as an ArrayBuffer
    const arrayBuffer = await response.arrayBuffer();

    // Convert the ArrayBuffer into a Uint8Array
    const uint8Array = new Uint8Array(arrayBuffer);

    // returm the PDF data in Uint8Array for PDFJS
    console.log("PDF loaded and converted to Uint8Array:", uint8Array);

    return uint8Array;

  } catch (error) {
    console.error("Error loading PDF:", error);
  }
};


export const extractAndHighlight = async (pdf, targetSentence, pageNumber = 1) => {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });

  const textItems = await extractTextFromPage(pdf, pageNumber); // Extract text from the first page
  const coordinates = findSentenceCoordinates(textItems, targetSentence);

  const normalizedCoordinates = coordinates!== null ? {
    x: coordinates.x / viewport.width,
    y: (viewport.height - coordinates.y - coordinates.height) / viewport.height, // Flip y-axis
    width: coordinates.width / viewport.width,
    height: coordinates.height / viewport.height,
  } : null;
  console.log('normalizedCoordinates', normalizedCoordinates, targetSentence, pageNumber);
};

// Function to extract and highlight a specific citation on a given page
export const extractAndHighlightCitation = async (pdf, targetCitation, pageNumber = 1) => {
  try {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });

    const textItems = await extractTextFromPage(pdf, pageNumber);
    const citations = findCitationCoordinates(textItems, targetCitation);

    // Normalize coordinates for the target citation relative to the page viewport
    const normalizedCitations = citations.map(citation => ({
      citation: citation.citation,
      x: citation.x / viewport.width,
      y: (viewport.height - citation.y - citation.height) / viewport.height,
      width: citation.width / viewport.width,
      height: citation.height / viewport.height,
    }));

    console.log('Normalized citation coordinates:', normalizedCitations, targetCitation);
    //return normalizedCitations;
  } catch (error) {
    console.error('Error in extractAndHighlightCitation:', error);
    return [];
  }
};
