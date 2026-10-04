import { NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const maxDuration = 60;

const BUCKET = "manga-files";

type Block = {
  source: string;
  translation: string;
  box_2d: number[];
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

function fitText(text: string, font: any, boxWidth: number, boxHeight: number) {
  let size = Math.max(7, Math.min(20, boxHeight * 0.28));
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

        page.drawRectangle({
          x: Math.max(0, x - 3),
          y: Math.max(0, y - 3),
          width: Math.min(width - x + 3, boxWidth + 6),
          height: Math.min(height - y + 3, boxHeight + 6),
          color: rgb(1, 1, 1),
          opacity: 0.96,
        });

        const fitted = fitText(block.translation, font, boxWidth, boxHeight);
        let textY = y + boxHeight - fitted.size - 2;

        for (const line of fitted.lines) {
          if (textY < y) break;
          page.drawText(line, {
            x: x + 4,
            y: textY,
            size: fitted.size,
            font,
            color: rgb(0.05, 0.05, 0.06),
            maxWidth: boxWidth - 8,
          });
          textY -= fitted.lineHeight;
        }
      }
    }

    const bytes = await pdf.save();
    const safeName = String(job.source_name || "translated")
      .replace(/\.pdf$/i, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_");

    return new Response(bytes, {
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
