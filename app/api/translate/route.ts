import { NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const maxDuration = 60;

const BUCKET = "manga-files";
const GEMINI_MODEL = "gemini-3.8-flash";
const MAX_PAGES_PER_BATCH = 2;
const GEMINI_TIMEOUT_MS = 50_000;

type Block = {
  source: string;
  translation: string;
  box_2d: number[];
};

type PageResult = {
  page: number;
  blocks: Block[];
};

type Layout = {
  pages: PageResult[];
};

function parseGeminiJson(text: string): Layout {
  const cleaned = text
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .trim();

  const parsed = JSON.parse(cleaned);
  if (!parsed || !Array.isArray(parsed.pages)) {
    throw new Error("Gemini javobi kutilgan JSON formatida emas.");
  }

  const pages: PageResult[] = parsed.pages.map((page: any) => ({
    page: Number(page.page),
    blocks: Array.isArray(page.blocks)
      ? page.blocks
          .map((block: any) => ({
            source: String(block.source || ""),
            translation: String(block.translation || ""),
            box_2d: Array.isArray(block.box_2d)
              ? block.box_2d.map(Number)
              : [],
          }))
          .filter((block: Block) =>
            Number.isFinite(Number(block.page)) === false &&
            block.box_2d.length === 4 &&
            block.box_2d.every(Number.isFinite),
          )
      : [],
  }));

  return { pages };
}

async function fetchGemini(
  apiKey: string,
  pdfBase64: string,
  prompt: string,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: "application/pdf",
                  data: pdfBase64,
                },
              },
            ],
          }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: "application/json",
          },
        }),
      },
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data?.error?.message ||
        data?.error?.status ||
        `Gemini API HTTP ${response.status}`,
      );
    }

    const text = data?.candidates?.[0]?.content?.parts
      ?.map((part: { text?: string }) => part.text || "")
      .join("")
      .trim();

    if (!text) {
      throw new Error("Gemini javobida tarjima topilmadi.");
    }

    return text;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        "Gemini javobi 50 soniyada kelmadi. Batch kichraytirilishi yoki qayta urinilishi kerak.",
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(request: Request) {
  let jobId = "";

  try {
    const body = await request.json();
    jobId = String(body?.jobId || "");
    const path = String(body?.path || "");
    const targetLanguage = String(body?.targetLanguage || "Uzbek");

    const requestedStart = Number(body?.startPage || 1);
    const requestedEnd = Number(body?.endPage || requestedStart + MAX_PAGES_PER_BATCH - 1);

    if (!jobId || !path || !path.startsWith(`jobs/${jobId}/source/`)) {
      return NextResponse.json({ error: "Noto'g'ri jobId yoki path" }, { status: 400 });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json({
        error: "GEMINI_API_KEY Vercel Environment Variables'da topilmadi.",
      }, { status: 500 });
    }

    if (
      !Number.isInteger(requestedStart) ||
      !Number.isInteger(requestedEnd) ||
      requestedStart < 1 ||
      requestedEnd < requestedStart
    ) {
      return NextResponse.json({ error: "Sahifa oralig'i noto'g'ri." }, { status: 400 });
    }

    const { data: signed, error: signedError } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUrl(path, 60 * 60);

    if (signedError || !signed?.signedUrl) {
      throw new Error(
        `PDF uchun vaqtinchalik URL yaratilmadi: ${signedError?.message || "unknown"}`,
      );
    }

    const pdfResponse = await fetch(signed.signedUrl);
    if (!pdfResponse.ok) {
      throw new Error(`PDF Storage'dan olinmadi: HTTP ${pdfResponse.status}`);
    }

    const sourceBytes = await pdfResponse.arrayBuffer();
    const sourcePdf = await PDFDocument.load(sourceBytes);
    const totalPages = sourcePdf.getPageCount();

    const startPage = Math.min(requestedStart, totalPages);
    const endPage = Math.min(
      requestedEnd,
      startPage + MAX_PAGES_PER_BATCH - 1,
      totalPages,
    );

    if (startPage > totalPages) {
      return NextResponse.json({
        ok: true,
        jobId,
        totalPages,
        startPage,
        endPage,
        done: true,
        pages: [],
      });
    }

    const batchPdf = await PDFDocument.create();
    const copiedPages = await batchPdf.copyPages(
      sourcePdf,
      Array.from(
        { length: endPage - startPage + 1 },
        (_, index) => startPage - 1 + index,
      ),
    );

    for (const page of copiedPages) {
      batchPdf.addPage(page);
    }

    const batchBytes = await batchPdf.save();

    if (batchBytes.byteLength > 15 * 1024 * 1024) {
      throw new Error(
        "Bu sahifalar batchi juda katta. Bir sahifalik tarjima bilan qayta urinib ko'ring.",
      );
    }

    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < batchBytes.length; i += chunkSize) {
      binary += String.fromCharCode(...batchBytes.subarray(i, i + chunkSize));
    }
    const pdfBase64 = btoa(binary);

    await supabaseAdmin.from("translation_jobs").update({
      status: "processing",
      progress: Math.round(((startPage - 1) / totalPages) * 100),
      current_page: startPage,
      total_pages: totalPages,
      target_language: targetLanguage,
      error_message: null,
      updated_at: new Date().toISOString(),
    }).eq("id", jobId);

    const prompt = `You are a professional manga/manhwa OCR and translator.

The attached PDF contains ORIGINAL pages ${startPage} through ${endPage}.
Translate only those pages into ${targetLanguage}.

Return ONLY valid JSON matching this exact shape:
{
  "pages": [
    {
      "page": 1,
      "blocks": [
        {
          "source": "original text",
          "translation": "Uzbek translation",
          "box_2d": [ymin, xmin, ymax, xmax]
        }
      ]
    }
  ]
}

IMPORTANT:
- "page" must be the ORIGINAL PDF page number, from ${startPage} to ${endPage}.
- box_2d uses 0-1000 normalized coordinates: [top, left, bottom, right].
- Detect every readable dialogue/caption/text block.
- Translate actual text; do not summarize.
- Preserve names, terminology, tone, honorific meaning, and sound-effect meaning.
- Keep separate text blocks separate.
- If a page has no readable text, return an empty blocks array.
- Do not invent text.
- Do not use Markdown fences.
- Output valid JSON only.`;

    const raw = await fetchGemini(apiKey, pdfBase64, prompt);
    const layout = parseGeminiJson(raw);

    const normalizedPages = layout.pages.filter((page) =>
      Number.isInteger(page.page) &&
      page.page >= startPage &&
      page.page <= endPage,
    );

    if (!normalizedPages.length) {
      throw new Error("Gemini hech qanday sahifa natijasini qaytarmadi.");
    }

    const { data: job, error: jobError } = await supabaseAdmin
      .from("translation_jobs")
      .select("translation_json,translation")
      .eq("id", jobId)
      .single();

    if (jobError) throw new Error(`Job o'qilmadi: ${jobError.message}`);

    const existing = (job?.translation_json || {}) as Layout;
    const existingPages = Array.isArray(existing.pages) ? existing.pages : [];
    const pageMap = new Map<number, PageResult>();

    for (const page of existingPages) pageMap.set(Number(page.page), page);
    for (const page of normalizedPages) pageMap.set(Number(page.page), page);

    const mergedPages = Array.from(pageMap.values()).sort((a, b) => a.page - b.page);
    const mergedLayout: Layout = { pages: mergedPages };

    const translationText = mergedPages
      .map((page) => {
        const text = page.blocks
          .map((block) => block.translation)
          .filter(Boolean)
          .join("\n");
        return `[PAGE ${page.page}]\n${text || "[NO TEXT]"}`;
      })
      .join("\n\n");

    const done = endPage >= totalPages;

    const { error: updateError } = await supabaseAdmin
      .from("translation_jobs")
      .update({
        status: done ? "completed" : "processing",
        progress: Math.round((endPage / totalPages) * 100),
        current_page: endPage,
        total_pages: totalPages,
        translation: translationText,
        translation_json: mergedLayout,
        updated_at: new Date().toISOString(),
      })
      .eq("id", jobId);

    if (updateError) {
      throw new Error(`Tarjima saqlanmadi: ${updateError.message}`);
    }

    return NextResponse.json({
      ok: true,
      jobId,
      totalPages,
      startPage,
      endPage,
      nextPage: done ? null : endPage + 1,
      done,
      translation: translationText,
      pages: normalizedPages,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    if (jobId) {
      await supabaseAdmin.from("translation_jobs").update({
        status: "failed",
        error_message: message,
        updated_at: new Date().toISOString(),
      }).eq("id", jobId);
    }

    console.error("translation_batch_error", error);

    return NextResponse.json({
      error: "AI tarjima batch xatosi",
      detail: message,
      retryable: true,
    }, { status: 500 });
  }
}
