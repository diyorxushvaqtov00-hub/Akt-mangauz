import { NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const maxDuration = 60;

const BUCKET = "manga-files";

type Block = {
  source: string;
  translation: string;
  box_2d: number[];
  background_color?: string;
  text_color?: string;
  font_weight?: "normal" | "bold";
  align?: "left" | "center" | "right";
  font_scale?: number;
};

type Layout = {
  pages: Array<{ page: number; blocks: Block[] }>;
};

function normalizeUzbek(text: string) {
  return text
    .replace(/[‘’ʻ]/g, "'")
    .replace(/“|”/g, '"')
    .replace(/–|—/g, "-");
}

function parseHexColor(value: unknown, fallback: [number, number, number]) {
  if (typeof value !== "string") return rgb(...fallback);
  const hex = value.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return rgb(...fallback);
  return rgb(
    parseInt(hex.slice(0, 2), 16) / 255,
    parseInt(hex.slice(2, 4), 16) / 255,
    parseInt(hex.slice(4, 6), 16) / 255,
  );
}

function wrapToWidth(text: string, font: any, size: number, maxWidth: number) {
  const words = normalizeUzbek(text).split(/\s+/);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const candidate = line ? line + " " + word : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function fitText(text: string, font: any, boxWidth: number, boxHeight: number, fontScale = 1) {
  let size = Math.max(7, Math.min(28, boxHeight * 0.28 * Math.max(0.75, Math.min(1.35, fontScale))));
  let lines = wrapToWidth(text, font, size, Math.max(20, boxWidth - 8));
  const lineHeight = size * 1.18;

  while ((lines.length * lineHeight > boxHeight - 6 || lines.some((l: string) => font.widthOfTextAtSize(l, size) > boxWidth - 8)) && size > 6) {
    size -= 0.5;
    lines = wrapToWidth(text, font, size, Math.max(20, boxWidth - 8));
  }

  return { size, lines, lineHeight: size * 1.18 };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const jobId = String(body?.jobId || "");
    if (!jobId) return NextResponse.json({ error: "jobId kerak" }, { status: 400 });

    const { data: job, error } = await supabaseAdmin
      .from("translation_jobs")
      .select("id,source_name,source_path,translation,translation_json,status")
      .eq("id", jobId)
      .single();

    if (error || !job) throw new Error("Tarjima topilmadi");
    if (job.status !== "completed") throw new Error("Tarjima hali tayyor emas");
    if (!job.source_path) throw new Error("Original PDF yo'li topilmadi");

    const { data: signed, error: signedError } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUrl(job.source_path, 60 * 60);

    if (signedError || !signed?.signedUrl) {
      throw new Error("Original PDF uchun vaqtinchalik URL yaratilmadi");
    }

    const sourceResponse = await fetch(signed.signedUrl);
    if (!sourceResponse.ok) throw new Error("Original PDF yuklab olinmadi");

    const sourceBytes = await sourceResponse.arrayBuffer();
    const pdf = await PDFDocument.load(sourceBytes);
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

    const layout = job.translation_json as Layout | null;
    if (!layout?.pages?.length) {
      throw new Error("Sahifa joylashuvi topilmadi. PDF'ni qayta tarjima qiling.");
    }

    for (const pageData of layout.pages) {
      const index = pageData.page - 1;
      if (index < 0 || index >= pdf.getPageCount()) continue;

      const page = pdf.getPage(index);
      const { width, height } = page.getSize();

      for (const block of pageData.blocks || []) {
        if (!block.translation?.trim() || !Array.isArray(block.box_2d) || block.box_2d.length !== 4) continue;

        const [ymin, xmin, ymax, xmax] = block.box_2d.map(Number);
        if (![ymin, xmin, ymax, xmax].every(Number.isFinite)) continue;

        const x = Math.max(0, Math.min(width, (xmin / 1000) * width));
        const yTop = Math.max(0, Math.min(height, (ymin / 1000) * height));
        const x2 = Math.max(x + 8, Math.min(width, (xmax / 1000) * width));
        const yBottomFromTop = Math.max(yTop + 8, Math.min(height, (ymax / 1000) * height));

        const boxWidth = x2 - x;
        const boxHeight = yBottomFromTop - yTop;
        const y = height - yBottomFromTop;

        // Fully cover the ORIGINAL lettering. The previous version used a semi-transparent
        // white rectangle, which left original text visible and destroyed dark speech bubbles.
        // Gemini now returns the detected bubble/panel colors so the replacement keeps the
        // original light/dark appearance instead of forcing every block to white.
        const backgroundColor = parseHexColor(block.background_color, [1, 1, 1]);
        const textColor = parseHexColor(block.text_color, [0.05, 0.05, 0.06]);
        const drawFont = block.font_weight === "bold" ? bold : font;
        const pad = Math.max(2, Math.min(6, Math.min(boxWidth, boxHeight) * 0.04));
        const fillX = Math.max(0, x - pad);
        const fillY = Math.max(0, y - pad);
        const fillWidth = Math.min(width - fillX, boxWidth + pad * 2);
        const fillHeight = Math.min(height - fillY, boxHeight + pad * 2);

        page.drawRectangle({
          x: fillX,
          y: fillY,
          width: fillWidth,
          height: fillHeight,
          color: backgroundColor,
          opacity: 1,
        });

        const fitted = fitText(
          block.translation,
          drawFont,
          boxWidth,
          boxHeight,
          Number(block.font_scale) || 1,
        );

        const textBlockHeight = fitted.lines.length * fitted.lineHeight;
        let textY = y + Math.max(0, (boxHeight + fitted.size) / 2 - textBlockHeight / 2);

        for (const line of fitted.lines) {
          if (textY < y - 1) break;
          const lineWidth = drawFont.widthOfTextAtSize(line, fitted.size);
          const align = block.align || "left";
          const textX =
            align === "center"
              ? x + Math.max(2, (boxWidth - lineWidth) / 2)
              : align === "right"
                ? x + Math.max(2, boxWidth - lineWidth - 2)
                : x + 2;

          page.drawText(line, {
            x: textX,
            y: textY,
            size: fitted.size,
            font: drawFont,
            color: textColor,
          });
          textY -= fitted.lineHeight;
        }
      }
    }

    const bytes = await pdf.save();
    const safeName = String(job.source_name || "translated")
      .replace(/\.pdf$/i, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_");

    return new Response(bytes as BodyInit, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${safeName}_uzbek_manga.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Export xatosi";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
