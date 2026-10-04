// js/utils/ai-report-pdf.js
//
// Convierte el informe en Markdown que redacta la IA en un PDF descargable.
// Sin dependencias de Firebase: el mismo archivo se usa en Estudiantes HUB
// (src/ai-report-pdf.js). Si lo cambias aquí, cópialo allá.
//
// pdfmake se carga solo al generar el primer informe, desde cdnjs y con SRI.

const PDFMAKE_VERSION = "0.2.12";
const PDFMAKE_SCRIPTS = [
  {
    src: `https://cdnjs.cloudflare.com/ajax/libs/pdfmake/${PDFMAKE_VERSION}/pdfmake.min.js`,
    integrity:
      "sha512-axXaF5grZBaYl7qiM6OMHgsgVXdSLxqq0w7F4CQxuFyrcPmn0JfnqsOtYHUun80g6mRRdvJDrTCyL8LQqBOt/Q==",
  },
  {
    src: `https://cdnjs.cloudflare.com/ajax/libs/pdfmake/${PDFMAKE_VERSION}/vfs_fonts.min.js`,
    integrity:
      "sha512-EFlschXPq/G5zunGPRSYqazR1CMKj0cQc8v6eMrQwybxgIbhsfoO5NAMQX3xFDQIbFlViv53o7Hy+yCWw6iZxA==",
  },
];

const BRAND_COLOR = "#5b2a86";
const MUTED_COLOR = "#6b6b7b";

let pdfMakeLoading = null;

function loadScript({ src, integrity }) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.integrity = integrity;
    script.crossOrigin = "anonymous";
    script.referrerPolicy = "no-referrer";
    script.onload = resolve;
    script.onerror = () => reject(new Error(`No se pudo cargar ${src}`));
    document.head.appendChild(script);
  });
}

function loadPdfMake() {
  if (window.pdfMake?.vfs) return Promise.resolve(window.pdfMake);
  if (!pdfMakeLoading) {
    pdfMakeLoading = PDFMAKE_SCRIPTS.reduce(
      (chain, script) => chain.then(() => loadScript(script)),
      Promise.resolve()
    )
      .then(() => window.pdfMake)
      .catch((error) => {
        pdfMakeLoading = null;
        throw error;
      });
  }
  return pdfMakeLoading;
}

// **negrita** y *cursiva* → fragmentos de texto de pdfmake.
function parseInline(line) {
  const parts = [];
  const pattern = /(\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_)/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(line))) {
    if (match.index > last) parts.push({ text: line.slice(last, match.index) });
    if (match[2] !== undefined) parts.push({ text: match[2], bold: true });
    else parts.push({ text: match[3] ?? match[4], italics: true });
    last = match.index + match[0].length;
  }
  if (last < line.length) parts.push({ text: line.slice(last) });
  return parts.length ? parts : [{ text: line }];
}

export function markdownToPdfContent(markdown = "") {
  const content = [];
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    content.push({ text: parseInline(paragraph.join(" ")), style: "body" });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    content.push({
      [list.ordered ? "ol" : "ul"]: list.items.map((item) => ({ text: parseInline(item), style: "listItem" })),
      margin: [8, 0, 0, 8],
    });
    list = null;
  };
  const flush = () => {
    flushParagraph();
    flushList();
  };

  String(markdown)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((rawLine) => {
      const line = rawLine.trim();
      if (!line) return flush();
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) return flush();

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flush();
        const level = Math.min(heading[1].length, 3);
        content.push({ text: heading[2].replace(/\*\*/g, ""), style: `h${level}` });
        return;
      }

      const bullet = line.match(/^[-*+•]\s+(.*)$/);
      const numbered = line.match(/^\d+[.)]\s+(.*)$/);
      if (bullet || numbered) {
        flushParagraph();
        const ordered = Boolean(numbered);
        if (!list || list.ordered !== ordered) {
          flushList();
          list = { ordered, items: [] };
        }
        list.items.push((bullet || numbered)[1]);
        return;
      }

      if (list && /^\s{2,}/.test(rawLine)) {
        list.items[list.items.length - 1] += ` ${line}`;
        return;
      }
      flushList();
      paragraph.push(line.replace(/^>\s?/, ""));
    });
  flush();
  return content;
}

export function slugifyReportName(value = "", fallback = "estudiante") {
  return (
    String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || fallback
  );
}

/**
 * Descarga el informe como PDF.
 * @param {{ markdown: string, studentName: string, periodLabel?: string, fileName: string }} options
 */
export async function downloadAiReportPdf({ markdown, studentName, periodLabel = "", fileName }) {
  const pdfMake = await loadPdfMake();
  const generatedAt = new Intl.DateTimeFormat("es-CO", { dateStyle: "long" }).format(new Date());
  const subtitle = [periodLabel ? `Período: ${periodLabel}` : "Todo el proceso", `Generado el ${generatedAt}`].join(" · ");

  const definition = {
    pageSize: "LETTER",
    pageMargins: [56, 64, 56, 64],
    info: { title: `Informe de proceso — ${studentName}`, author: "Musicala", creator: "Musicala" },
    header: {
      columns: [
        { text: "MUSICALA", style: "brand" },
        { text: studentName, style: "headerRight" },
      ],
      margin: [56, 28, 56, 0],
    },
    footer: (currentPage, pageCount) => ({
      columns: [
        { text: "Informe redactado con IA a partir de las bitácoras de clase.", style: "footer" },
        { text: `${currentPage} / ${pageCount}`, style: "footer", alignment: "right" },
      ],
      margin: [56, 24, 56, 0],
    }),
    content: [
      { text: subtitle, style: "meta" },
      ...markdownToPdfContent(markdown),
    ],
    defaultStyle: { font: "Roboto", fontSize: 10.5, lineHeight: 1.3, color: "#222222" },
    styles: {
      brand: { fontSize: 9, bold: true, color: BRAND_COLOR, characterSpacing: 2 },
      headerRight: { fontSize: 9, color: MUTED_COLOR, alignment: "right" },
      footer: { fontSize: 8, color: MUTED_COLOR },
      meta: { fontSize: 9, color: MUTED_COLOR, margin: [0, 0, 0, 14] },
      h1: { fontSize: 18, bold: true, color: BRAND_COLOR, margin: [0, 0, 0, 10] },
      h2: { fontSize: 13, bold: true, color: BRAND_COLOR, margin: [0, 12, 0, 6] },
      h3: { fontSize: 11, bold: true, margin: [0, 8, 0, 4] },
      body: { margin: [0, 0, 0, 8], alignment: "justify" },
      listItem: { margin: [0, 0, 0, 3] },
    },
  };

  await new Promise((resolve) => {
    pdfMake.createPdf(definition).download(`${fileName}.pdf`, resolve);
  });
}
