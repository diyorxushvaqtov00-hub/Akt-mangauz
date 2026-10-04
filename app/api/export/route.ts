import { NextResponse } from "next/server";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const maxDuration = 30;

function wrapText(text: string, maxChars = 92) {
  const lines: string[] = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    if (!raw.trim()) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of raw.split(/\s+/)) {
      const candidate = line ? line + " " + word : word;
      if (candidate.length > maxChars && line) {
        lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const jobId = String(body?.jobId || "");
    if (!jobId) return NextResponse.json({ error: "jobId kerak" }, { status: 400 });

    const { data: job, error } = await supabaseAdmin
      .from("translation_jobs")
      .select("id,source_name,translation,status")
      .eq("id", jobId)
      .single();

    if (error || !job) throw new Error("Tarjima topilmadi");
    if (job.status !== "completed" || !job.translation) {
      throw new Error("Tarjima hali tayyor emas");
    }

    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

    const pages = String(job.translation).split(/(?=\[PAGE\s+\d+\])/g);
    for (const pageText of pages) {
      const page = pdf.addPage([595.28, 841.89]);
      const { width, height } = page.getSize();
      let y = height - 54;

      page.drawText("AI Manga Translator", {
        x: 40, y, size: 11, font: bold, color: rgb(0.55, 0.35, 0.95),
      });
      y -= 28;

      for (const line of wrapText(pageText.trim())) {
        if (y < 48) {
          y = height - 48;
          pdf.addPage([595.28, 841.89]);
        }
        const targetPage = pdf.getPages()[pdf.getPageCount() - 1];
        targetPage.drawText(line || " ", {
          x: 40, y, size: 10.5, font, color: rgb(0.1, 0.1, 0.12),
          maxWidth: width - 80,
        });
        y -= 16;
      }
    }

    const bytes = await pdf.save();
    const safeName = String(job.source_name || "translated")
      .replace(/\.pdf$/i, "")
      .replace(/[^a-zA-Z0-9_-]+/g, "_");

    return new Response(bytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${safeName}_uzbek_translation.pdf"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Export xatosi";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
