import { NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const maxDuration = 60;

const BUCKET = "manga-files";
const GEMINI_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.7-flash",
] as const;
const OPENAI_MODEL = "gpt-5-mini";
const MAX_PAGES_PER_BATCH = 2;
const GEMINI_ATTEMPT_TIMEOUT_MS = 15_000;
const OPENAI_ATTEMPT_TIMEOUT_MS = 20_000;

type Block = {
  id?: string;
  type?: "dialogue" | "thought" | "narration" | "shout" | "sfx" | "sign" | "background" | "vertical" | "rotated" | "unknown";
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
  font_class?: "sans" | "sans_bold" | "serif" | "serif_bold" | "handwritten" | "manga" | "impact" | "condensed" | "decorative" | "unknown";
  stroke_color?: string;
  stroke_width?: number;
  shadow_color?: string;
  shadow_opacity?: number;
  line_spacing?: number;
  confidence?: number;
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
            id: typeof block.id === "string" ? block.id : undefined,
            type: ["dialogue","thought","narration","shout","sfx","sign","background","vertical","rotated","unknown"].includes(block.type)
              ? block.type
              : "unknown",
            source: String(block.source || ""),
            translation: String(block.translation || ""),
            box_2d: Array.isArray(block.box_2d)
              ? block.box_2d.map(Number)
              : [],
            polygon_2d: Array.isArray(block.polygon_2d)
              ? block.polygon_2d
                  .filter((point: any) => Array.isArray(point) && point.length === 2)
                  .map((point: any) => [Number(point[0]), Number(point[1])])
                  .filter((point: number[]) => point.every(Number.isFinite))
              : undefined,
            background_color: typeof block.background_color === "string" ? block.background_color : undefined,
            text_color: typeof block.text_color === "string" ? block.text_color : undefined,
            font_weight: block.font_weight === "bold" ? "bold" : "normal",
            align: block.align === "center" || block.align === "right" ? block.align : "left",
            font_scale: Number.isFinite(Number(block.font_scale)) ? Number(block.font_scale) : 1,
            rotation: Number.isFinite(Number(block.rotation)) ? Number(block.rotation) : 0,
            font_class: ["sans","sans_bold","serif","serif_bold","handwritten","manga","impact","condensed","decorative","unknown"].includes(block.font_class)
              ? block.font_class
              : "unknown",
            stroke_color: typeof block.stroke_color === "string" ? block.stroke_color : undefined,
            stroke_width: Number.isFinite(Number(block.stroke_width)) ? Number(block.stroke_width) : 0,
            shadow_color: typeof block.shadow_color === "string" ? block.shadow_color : undefined,
            shadow_opacity: Number.isFinite(Number(block.shadow_opacity)) ? Number(block.shadow_opacity) : 0,
            line_spacing: Number.isFinite(Number(block.line_spacing)) ? Number(block.line_spacing) : 1.15,
            confidence: Number.isFinite(Number(block.confidence)) ? Number(block.confidence) : 0.8,
          }))
          .filter((block: Block) =>
            block.box_2d.length === 4 &&
            block.box_2d.every(Number.isFinite),
          )
      : [],
  }));

  return { pages };
}

function isTransientGeminiError(status: number, message: string) {
  const normalized = message.toLowerCase();
  return (
    status === 408 ||
    status === 409 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    normalized.includes("high demand") ||
    normalized.includes("overloaded") ||
    normalized.includes("temporarily unavailable") ||
    normalized.includes("try again later") ||
    normalized.includes("rate limit") ||
    normalized.includes("resource exhausted")
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchGeminiOnce(
  apiKey: string,
  model: string,
  pdfBase64: string,
  prompt: string,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
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
            responseMimeType: "application/json",
          },
        }),
      },
    );

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const message =
        data?.error?.message ||
        data?.error?.status ||
        `Gemini API HTTP ${response.status}`;
      const error = new Error(message);
      (error as Error & { status?: number; retryable?: boolean }).status = response.status;
      (error as Error & { status?: number; retryable?: boolean }).retryable =
        isTransientGeminiError(response.status, message);
      throw error;
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
      const timeoutError = new Error(
        `Gemini ${model} javobi ${Math.round(timeoutMs / 1000)} soniyada kelmadi.`,
      );
      (timeoutError as Error & { retryable?: boolean }).retryable = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOpenAIOnce(
  apiKey: string,
  pdfBase64: string,
  prompt: string,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: OPENAI_MODEL,
        input: [{
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            {
              type: "input_file",
              filename: "manga-batch.pdf",
              file_data: `data:application/pdf;base64,${pdfBase64}`,
            },
          ],
        }],
      }),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const message =
        data?.error?.message ||
        data?.error?.code ||
        `OpenAI API HTTP ${response.status}`;
      const error = new Error(message);
      (error as Error & { retryable?: boolean }).retryable =
        response.status === 408 ||
        response.status === 409 ||
        response.status === 429 ||
        response.status >= 500;
      throw error;
    }

    const text =
      typeof data?.output_text === "string"
        ? data.output_text.trim()
        : Array.isArray(data?.output)
          ? data.output
              .flatMap((item: any) => Array.isArray(item?.content) ? item.content : [])
              .map((part: any) => part?.text || "")
              .join("")
              .trim()
          : "";

    if (!text) {
      throw new Error("OpenAI javobida tarjima topilmadi.");
    }

    return text;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      const timeoutError = new Error(
        `OpenAI ${OPENAI_MODEL} javobi ${Math.round(timeoutMs / 1000)} soniyada kelmadi.`,
      );
      (timeoutError as Error & { retryable?: boolean }).retryable = true;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTranslation(
  geminiApiKey: string | undefined,
  openaiApiKey: string | undefined,
  pdfBase64: string,
  prompt: string,
) {
  const failures: string[] = [];

  if (geminiApiKey) {
    for (const model of GEMINI_MODELS) {
      try {
        return await fetchGeminiOnce(
          geminiApiKey,
          model,
          pdfBase64,
          prompt,
          GEMINI_ATTEMPT_TIMEOUT_MS,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown Gemini error";
        failures.push(`Gemini ${model}: ${message}`);
        // Quota/rate-limit errors should immediately move to the next provider.
        // Retrying the same exhausted quota does not increase the quota.
      }
    }
  } else {
    failures.push("Gemini: GEMINI_API_KEY mavjud emas.");
  }

  if (openaiApiKey) {
    try {
      return await fetchOpenAIOnce(
        openaiApiKey,
        pdfBase64,
        prompt,
        OPENAI_ATTEMPT_TIMEOUT_MS,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown OpenAI error";
      failures.push(`OpenAI ${OPENAI_MODEL}: ${message}`);
    }
  } else {
    failures.push("OpenAI: OPENAI_API_KEY mavjud emas.");
  }

  throw new Error(
    `Barcha AI providerlar ishlamadi. ${failures.join(" | ")}`,
  );
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

    const geminiApiKey = process.env.GEMINI_API_KEY;
    const openaiApiKey = process.env.OPENAI_API_KEY;

    if (!geminiApiKey && !openaiApiKey) {
      return NextResponse.json({
        error: "AI API key topilmadi. GEMINI_API_KEY yoki OPENAI_API_KEY Vercel Environment Variables'da kerak.",
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

The attached PDF is a batch extracted from an ORIGINAL PDF.
The first attached page is ORIGINAL PDF page ${startPage}.
The last attached page is ORIGINAL PDF page ${endPage}.
If there are multiple attached pages, their original numbers increase sequentially from ${startPage}.
Translate only these original pages into ${targetLanguage}.

Return ONLY valid JSON matching this exact shape:
{
  "pages": [
    {
      "page": 1,
      "blocks": [
        {
          "id": "stable-page-local-id",
          "type": "dialogue|thought|narration|shout|sfx|sign|background|vertical|rotated|unknown",
          "source": "original text",
          "translation": "Uzbek translation",
          "box_2d": [ymin, xmin, ymax, xmax],
          "polygon_2d": [[y,x],[y,x],[y,x],[y,x]],
          "background_color": "#FFFFFF",
          "text_color": "#111111",
          "font_weight": "normal",
          "align": "center",
          "font_scale": 1.0,
          "rotation": 0,
          "font_class": "sans",
          "stroke_color": "#000000",
          "stroke_width": 0,
          "shadow_color": "#000000",
          "shadow_opacity": 0,
          "line_spacing": 1.15,
          "confidence": 0.95
        }
      ]
    }
  ]
}

IMPORTANT:
- "page" MUST be the ORIGINAL PDF page number, not the position inside the attached batch. For example, the first attached page must be page ${startPage}, the second must be page ${Math.min(startPage + 1, endPage)}.
- box_2d uses 0-1000 normalized coordinates: [top, left, bottom, right].
- Detect every readable dialogue, thought, narration, SFX, sign, background, vertical, and rotated text block.
- Return a tight polygon_2d around the actual lettering when possible, plus a conservative box_2d around it.
- Classify every block using type.
- Translate actual text; do not summarize.
- Preserve names, terminology, tone, honorific meaning, and sound-effect meaning.
- Keep separate text blocks separate.
- If a page has no readable text, return an empty blocks array.
- Do not invent text.
- SFX must be classified as sfx and translated as a sound effect, not as ordinary dialogue.
- Do not use Markdown fences.
- Output valid JSON only.

For EVERY text block also analyze the visual style of the ORIGINAL text area and return:
- "background_color": the dominant bubble/panel background color as a 6-digit hex color, e.g. "#FFFFFF", "#000000", "#D9D9D9". If the area is clearly black/dark, use the actual dark color.
- "text_color": the intended text color as a 6-digit hex color, normally "#FFFFFF" on dark bubbles and "#111111" on light bubbles.
- "font_weight": "bold" only when the original lettering is clearly bold/heavy; otherwise "normal".
- "align": "center" for centered speech bubbles, "right" for right-aligned text, otherwise "left".
- "font_scale": a number from 0.75 to 1.35 that estimates the original lettering size relative to the detected box. Use larger values for titles/shouts and smaller values for dense dialogue.
- "rotation": approximate text rotation in degrees, normally between -90 and 90.
- "font_class": choose the closest visual class: sans, sans_bold, serif, serif_bold, handwritten, manga, impact, condensed, decorative, unknown.
- "stroke_color" and "stroke_width": detect outline around letters. Use 0 when none.
- "shadow_color" and "shadow_opacity": detect a visible shadow. Use 0 opacity when none.
- "line_spacing": approximate line spacing multiplier, normally 1.0 to 1.4.
- "confidence": confidence from 0 to 1 for the block detection/style metadata.
IMPORTANT: A black speech bubble with white lettering MUST stay black with white translated lettering. Do not default every block to a white background.`;

    const raw = await fetchTranslation(
      geminiApiKey,
      openaiApiKey,
      pdfBase64,
      prompt,
    );
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
