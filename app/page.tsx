"use client";

import { useMemo, useState } from "react";
import { jsPDF } from "jspdf";

type Block = {
  id?: string;
  type?: string;
  source: string;
  translation: string;
  box_2d: number[];
  polygon_2d?: number[][];
  background_color?: string;
  text_color?: string;
  font_weight?: "normal" | "bold";
  align?: "left" | "center" | "right";
  font_scale?: number;
  rotation?: number;
  font_class?: string;
  stroke_color?: string;
  stroke_width?: number;
  shadow_color?: string;
  shadow_opacity?: number;
  line_spacing?: number;
  confidence?: number;
};

type PageLayout = { page: number; blocks: Block[] };

type TranslationResponse = {
  error?: string;
  detail?: string;
  translation?: string;
  totalPages?: number;
  nextPage?: number | null;
  done?: boolean;
  pages?: PageLayout[];
};

async function readResponse(response: Response) {
  const text = await response.text();
  try {
    return { data: JSON.parse(text) as any, raw: text };
  } catch {
    return { data: {}, raw: text };
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function hexToRgb(hex: string | undefined, fallback: [number, number, number]) {
  if (!hex || !/^#[0-9a-fA-F]{6}$/.test(hex.trim())) return fallback;
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ] as [number, number, number];
}

function fontFamily(fontClass?: string) {
  switch (fontClass) {
    case "serif":
    case "serif_bold":
      return "Georgia, Times New Roman, serif";
    case "handwritten":
      return "Comic Sans MS, cursive";
    case "impact":
      return "Impact, Arial Black, sans-serif";
    case "condensed":
      return "Arial Narrow, Arial, sans-serif";
    case "manga":
      return "Arial Black, Impact, sans-serif";
    case "decorative":
      return "Trebuchet MS, Arial, sans-serif";
    default:
      return "Arial, Helvetica, sans-serif";
  }
}

function wrapCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? line + " " + word : word;
    if (!line || ctx.measureText(candidate).width <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function fitCanvasText(
  ctx: CanvasRenderingContext2D,
  text: string,
  width: number,
  height: number,
  block: Block,
) {
  const scale = clamp(Number(block.font_scale) || 1, 0.65, 1.4);
  const minSize = Math.max(10, Math.round(Math.min(width, height) * 0.035));
  let size = Math.max(minSize, Math.min(height * 0.28, height * 0.48)) * scale;
  size = Math.max(12, size);

  while (size >= minSize) {
    ctx.font = `${block.font_weight === "bold" ? "700" : "400"} ${size}px ${fontFamily(block.font_class)}`;
    const lines = wrapCanvasText(ctx, block.translation, Math.max(20, width - 12));
    const lineSpacing = clamp(Number(block.line_spacing) || 1.15, 0.9, 1.5);
    const lineHeight = size * lineSpacing;

    if (
      lines.length * lineHeight <= Math.max(12, height - 8) &&
      lines.every((line) => ctx.measureText(line).width <= width - 8)
    ) {
      return { size, lines, lineHeight };
    }

    size -= Math.max(1, size * 0.045);
  }

  ctx.font = `400 ${minSize}px ${fontFamily(block.font_class)}`;
  return {
    size: minSize,
    lines: wrapCanvasText(ctx, block.translation, Math.max(20, width - 8)),
    lineHeight: minSize * 1.08,
  };
}

async function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Sahifa rasmi ochilmadi."));
    image.src = dataUrl;
  });
}

async function renderPdfPages(file: File) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data: bytes, disableWorker: true }).promise;
  const pages: string[] = [];

  for (let index = 1; index <= pdf.numPages; index += 1) {
    const page = await pdf.getPage(index);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(2.2, Math.max(1, 1800 / baseViewport.width));
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);

    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Canvas yaratilmadi.");

    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvasContext: context,
      viewport,
    }).promise;

    pages.push(canvas.toDataURL("image/jpeg", 0.92));
  }

  return pages;
}

async function cleanupPage(image: string, blocks: Block[]) {
  if (!blocks.length) return { image, usedAI: false };

  const response = await fetch("/api/clean-page", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image, blocks }),
  });

  const result = await readResponse(response);
  if (!response.ok || !result.data?.image) {
    throw new Error(
      result.data?.error ||
        result.raw ||
        `Sahifani tozalash xatosi (HTTP ${response.status})`,
    );
  }

  return { image: String(result.data.image), usedAI: true };
}

function drawTranslatedPage(
  sourceImage: HTMLImageElement,
  blocks: Block[],
  warningLabel?: string,
) {
  const canvas = document.createElement("canvas");
  canvas.width = sourceImage.naturalWidth || sourceImage.width;
  canvas.height = sourceImage.naturalHeight || sourceImage.height;

  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Final canvas yaratilmadi.");

  ctx.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);

  for (const block of blocks) {
    if (!block.translation?.trim()) continue;
    if (!Array.isArray(block.box_2d) || block.box_2d.length !== 4) continue;

    const [top, left, bottom, right] = block.box_2d.map(Number);
    if (![top, left, bottom, right].every(Number.isFinite)) continue;

    const x = clamp(left / 1000, 0, 1) * canvas.width;
    const y = clamp(top / 1000, 0, 1) * canvas.height;
    const x2 = clamp(right / 1000, 0, 1) * canvas.width;
    const y2 = clamp(bottom / 1000, 0, 1) * canvas.height;
    const width = Math.max(8, x2 - x);
    const height = Math.max(8, y2 - y);

    const [r, g, b] = hexToRgb(block.text_color, [20, 20, 20]);
    const [sr, sg, sb] = hexToRgb(block.stroke_color, [0, 0, 0]);
    const shadow = hexToRgb(block.shadow_color, [0, 0, 0]);

    const fitted = fitCanvasText(ctx, block.translation, width, height, block);
    const rotation = clamp(Number(block.rotation) || 0, -90, 90);

    ctx.save();
    ctx.translate(x + width / 2, y + height / 2);
    ctx.rotate((rotation * Math.PI) / 180);

    ctx.font = `${block.font_weight === "bold" ? "700" : "400"} ${fitted.size}px ${fontFamily(block.font_class)}`;
    ctx.textBaseline = "middle";
    ctx.textAlign =
      block.align === "right"
        ? "right"
        : block.align === "center"
          ? "center"
          : "left";

    const linesHeight = fitted.lines.length * fitted.lineHeight;
    const startY = -linesHeight / 2 + fitted.lineHeight / 2;

    fitted.lines.forEach((line, index) => {
      const lineY = startY + index * fitted.lineHeight;
      const textX =
        block.align === "right"
          ? width / 2
          : block.align === "center"
            ? 0
            : -width / 2 + 4;

      const shadowOpacity = clamp(Number(block.shadow_opacity) || 0, 0, 1);
      if (shadowOpacity > 0) {
        ctx.shadowColor = `rgba(${shadow[0]},${shadow[1]},${shadow[2]},${shadowOpacity})`;
        ctx.shadowBlur = Math.max(1, fitted.size * 0.08);
        ctx.shadowOffsetX = fitted.size * 0.04;
        ctx.shadowOffsetY = fitted.size * 0.04;
      }

      if ((Number(block.stroke_width) || 0) > 0) {
        ctx.lineJoin = "round";
        ctx.lineWidth = Math.max(1, Number(block.stroke_width) || 0);
        ctx.strokeStyle = `rgb(${sr},${sg},${sb})`;
        ctx.strokeText(line, textX, lineY);
      }

      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillText(line, textX, lineY);

      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    });

    ctx.restore();
  }

  if (warningLabel) {
    ctx.save();
    ctx.fillStyle = "rgba(255,180,0,0.85)";
    ctx.fillRect(8, 8, 230, 28);
    ctx.fillStyle = "#111";
    ctx.font = "bold 13px Arial";
    ctx.fillText(warningLabel, 14, 27);
    ctx.restore();
  }

  return canvas;
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState("PDF faylni tanlang");
  const [busy, setBusy] = useState(false);
  const [translation, setTranslation] = useState("");
  const [jobId, setJobId] = useState("");
  const [progress, setProgress] = useState(0);
  const [quality, setQuality] = useState("");

  const selectedLabel = useMemo(
    () => (file ? `${file.name} • ${(file.size / 1024 / 1024).toFixed(2)} MB` : "PDF faylni shu yerga tanlang"),
    [file],
  );

  async function startUpload() {
    if (!file || busy) return;
    setBusy(true);
    setTranslation("");
    setJobId("");
    setProgress(0);
    setQuality("");
    setStatus("Upload URL tayyorlanmoqda...");

    try {
      const init = await fetch("/api/upload/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, size: file.size }),
      });
      const initResult = await readResponse(init);
      const initData = initResult.data as {
        error?: string;
        jobId?: string;
        path?: string;
        signedUrl?: string;
      };

      if (!init.ok) {
        throw new Error(initData.error || initResult.raw || "Upload init xatosi");
      }

      if (!initData.jobId || !initData.path || !initData.signedUrl) {
        throw new Error("Upload init javobi to‘liq emas.");
      }

      setStatus("PDF yuklanmoqda...");
      const upload = await fetch(initData.signedUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/pdf", "x-upsert": "false" },
        body: file,
      });

      if (!upload.ok) {
        throw new Error(
          (await upload.text().catch(() => "")) ||
            `PDF Storage'ga yuklanmadi (HTTP ${upload.status})`,
        );
      }

      const complete = await fetch("/api/upload/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: initData.jobId, path: initData.path }),
      });
      const completeResult = await readResponse(complete);

      if (!complete.ok) {
        throw new Error(
          completeResult.data?.error ||
            completeResult.raw ||
            "PDF tekshiruvi xatosi",
        );
      }

      setStatus("AI OCR + kontekstli tarjima boshlanmoqda...");

      let nextPage = 1;
      let totalPages = 0;
      let finalTranslation = "";

      while (nextPage) {
        const batchStart = nextPage;
        const batchEnd = batchStart + 1;

        async function runBatch(endPage: number) {
          const response = await fetch("/api/translate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              jobId: initData.jobId,
              path: initData.path,
              targetLanguage: "Uzbek",
              startPage: batchStart,
              endPage,
            }),
          });
          const result = await readResponse(response);
          return { response, result };
        }

        let { response: translate, result: translateResult } = await runBatch(batchEnd);
        let translateData = translateResult.data as TranslationResponse;

        if (!translate.ok && batchEnd !== batchStart) {
          setStatus(`Sahifa ${batchStart} og‘ir — 1 sahifalik rejimga o‘tilmoqda...`);
          ({ response: translate, result: translateResult } = await runBatch(batchStart));
          translateData = translateResult.data as TranslationResponse;
        }

        if (!translate.ok) {
          throw new Error(
            translateData.detail ||
              translateData.error ||
              translateResult.raw ||
              `AI tarjima xatosi (HTTP ${translate.status})`,
          );
        }

        totalPages = Number(translateData.totalPages || totalPages);
        finalTranslation = String(translateData.translation || "");
        setProgress(Math.round(((translateData.nextPage ? batchEnd : totalPages) / Math.max(1, totalPages)) * 70));

        if (translateData.done) {
          nextPage = 0;
        } else {
          nextPage = Number(translateData.nextPage || 0);
        }
      }

      setTranslation(finalTranslation);
      setJobId(initData.jobId);
      setProgress(70);
      setStatus(`Tarjima tayyor: ${totalPages}/${totalPages} sahifa. Endi professional tozalash va typesetting...`);

      const layoutResponse = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: initData.jobId,
          path: initData.path,
          targetLanguage: "Uzbek",
          startPage: 1,
          endPage: 1,
        }),
      }).catch(() => null);

      void layoutResponse;

      setProgress(72);
      setStatus("PDF sahifalari telefonda render qilinmoqda...");
    } catch (error) {
      setStatus(error instanceof Error ? `Xato: ${error.message}` : "Upload/AI xatosi");
    } finally {
      setBusy(false);
    }
  }

  async function exportProfessionalPdf() {
    if (!file || !jobId || busy) return;
    setBusy(true);
    setQuality("");
    setProgress(72);

    try {
      const pageImages = await renderPdfPages(file);

      const jobDataResponse = await fetch("/api/job-layout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });

      const layoutResult = await readResponse(jobDataResponse);
      if (!jobDataResponse.ok || !layoutResult.data?.layout?.pages) {
        throw new Error(
          layoutResult.data?.error ||
            layoutResult.raw ||
            "Tarjima layoutini olishning iloji bo‘lmadi.",
        );
      }

      const pages = layoutResult.data.layout.pages as PageLayout[];
      const pageMap = new Map<number, PageLayout>(
        pages.map((page: PageLayout) => [Number(page.page), page]),
      );

      const pdf = new jsPDF({
        unit: "px",
        format: [pageImages[0] ? (await loadImage(pageImages[0])).naturalWidth : 800, pageImages[0] ? (await loadImage(pageImages[0])).naturalHeight : 1100],
        compress: true,
      });

      let warningCount = 0;

      for (let index = 0; index < pageImages.length; index += 1) {
        const pageNumber = index + 1;
        setStatus(`Sahifa ${pageNumber}/${pageImages.length}: original matn tozalanmoqda...`);
        setProgress(72 + Math.round((index / Math.max(1, pageImages.length)) * 24));

        const original = await loadImage(pageImages[index]);
        const blocks = pageMap.get(pageNumber)?.blocks || [];

        let cleanData = pageImages[index];
        let cleanupFailed = false;

        if (blocks.length) {
          try {
            const cleaned = await cleanupPage(pageImages[index], blocks);
            cleanData = cleaned.image;
          } catch (error) {
            cleanupFailed = true;
            warningCount += 1;
            console.warn("page_cleanup_failed", pageNumber, error);
          }
        }

        const cleanedImage = await loadImage(cleanData);
        const finalCanvas = drawTranslatedPage(
          cleanedImage,
          blocks,
          cleanupFailed ? "CLEANUP WARNING" : undefined,
        );

        if (index > 0) {
          pdf.addPage([finalCanvas.width, finalCanvas.height], finalCanvas.width >= finalCanvas.height ? "landscape" : "portrait");
        } else {
          // The constructor used page 1 dimensions.
          pdf.deletePage(1);
          pdf.addPage([finalCanvas.width, finalCanvas.height], finalCanvas.width >= finalCanvas.height ? "landscape" : "portrait");
        }

        pdf.addImage(
          finalCanvas.toDataURL("image/jpeg", 0.94),
          "JPEG",
          0,
          0,
          finalCanvas.width,
          finalCanvas.height,
          undefined,
          "FAST",
        );
      }

      setProgress(98);
      setStatus("Final PDF yaratilmoqda...");
      const blob = pdf.output("blob");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        (file.name.replace(/\\.pdf$/i, "") || "translated") +
        "_uzbek_manga_professional.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      setProgress(100);
      setQuality(
        warningCount
          ? `Tayyor. ${warningCount} sahifada AI cleanup fallback ishladi — tekshirish tavsiya qilinadi.`
          : "QA: sahifalar tozalandi, tarjima joylashtirildi va PDF eksport qilindi.",
      );
      setStatus("Professional tarjima PDF tayyor.");
    } catch (error) {
      setStatus(
        error instanceof Error
          ? `Professional export xatosi: ${error.message}`
          : "Professional export xatosi",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <header className="nav">
        <div className="brand"><span>AI</span> Manga Translator</div>
        <div className="badge">PRO PIPELINE • v1.0</div>
      </header>

      <section className="hero">
        <div className="eyebrow">OCR • TRANSLATION • CLEANUP • TYPESETTING • QA</div>
        <h1>PDF manga → <span>Professional Uzbek</span></h1>
        <p>
          Original yozuvlar oddiy oq to‘rtburchak bilan yopilmaydi.
          Har bir text region alohida tahlil qilinadi, fon tiklanadi va tarjima
          original uslubga mos ravishda qayta joylashtiriladi.
        </p>

        <label className="upload">
          <input
            type="file"
            accept=".pdf,application/pdf"
            onChange={(event) => {
              const selected = event.target.files?.[0];
              if (!selected) return;
              if (
                selected.type !== "application/pdf" &&
                !selected.name.toLowerCase().endsWith(".pdf")
              ) {
                setFile(null);
                setStatus("Faqat PDF fayl qabul qilinadi.");
                return;
              }
              if (selected.size > 100 * 1024 * 1024) {
                setFile(null);
                setStatus("PDF 100 MB dan kichik bo‘lishi kerak.");
                return;
              }
              setFile(selected);
              setTranslation("");
              setJobId("");
              setProgress(0);
              setQuality("");
              setStatus("PDF qabul qilindi — professional tarjimaga tayyor.");
            }}
          />
          <div className="uploadIcon">↑</div>
          <strong>{selectedLabel}</strong>
          <small>Faqat PDF • maksimum 100 MB</small>
        </label>

        <div className={file ? "status success" : "status"}>{status}</div>

        {progress > 0 && (
          <div style={{ maxWidth: 620, margin: "16px auto 0", textAlign: "left" }}>
            <div style={{ display: "flex", justifyContent: "space-between", color: "#aaa7b5", fontSize: 12 }}>
              <span>Pipeline</span><span>{progress}%</span>
            </div>
            <div style={{ height: 8, background: "#211f2c", borderRadius: 99, overflow: "hidden", marginTop: 7 }}>
              <div style={{ width: `${progress}%`, height: "100%", background: "linear-gradient(90deg,#8b5cf6,#c4b5fd)", transition: "width .3s" }} />
            </div>
          </div>
        )}

        <button className="primary" disabled={!file || busy} onClick={startUpload}>
          {busy ? "AI ishlayapti..." : file ? "1. PDF → OCR + AI tarjima" : "Avval PDF tanlang"}
        </button>

        {translation && (
          <div
            className="status success"
            style={{
              marginTop: 16,
              textAlign: "left",
              whiteSpace: "pre-wrap",
              maxHeight: 300,
              overflow: "auto",
            }}
          >
            {translation}
          </div>
        )}

        {jobId && (
          <button
            className="primary"
            style={{ marginTop: 12 }}
            disabled={busy}
            onClick={exportProfessionalPdf}
          >
            {busy ? "Professional renderer ishlayapti..." : "2. Professional cleanup + typesetting + PDF"}
          </button>
        )}

        {quality && (
          <div className="status success" style={{ marginTop: 14 }}>
            {quality}
          </div>
        )}
      </section>

      <section className="pipeline">
        {[
          ["01", "PDF Render", "Har bir sahifa yuqori sifatli image sifatida tayyorlanadi."],
          ["02", "OCR + Style", "Text region, turi, rang, font klassi, stroke, rotation va polygon aniqlanadi."],
          ["03", "Translation", "Kontekstli o‘zbekcha tarjima va character memory."],
          ["04", "AI Cleanup", "Original lettering olib tashlanadi, artwork va bubble fonlari saqlanadi."],
          ["05", "Typesetting", "Tarjima alohida renderer orqali style metadata bilan joylashtiriladi."],
          ["06", "QA", "Overflow, original residue va cleanup failure holatlari nazorat qilinadi."],
        ].map(([number, title, description]) => (
          <article key={number}>
            <span>{number}</span>
            <h3>{title}</h3>
            <p>{description}</p>
          </article>
        ))}
      </section>

      <footer>AI Manga Translator • Professional Translation Core</footer>
    </main>
  );
}
