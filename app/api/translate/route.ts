import { NextResponse } from "next/server";
import { generateText, Output } from "ai";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const maxDuration = 60;

const BUCKET = "manga-files";

const blockSchema = z.object({
  source: z.string().describe("Original readable dialogue, narration, label, or sound effect."),
  translation: z.string().describe("Natural Uzbek translation."),
  box_2d: z.array(z.number()).length(4).describe("[ymin,xmin,ymax,xmax] normalized from 0 to 1000."),
});

const pageSchema = z.object({
  page: z.number().int().min(1),
  blocks: z.array(blockSchema),
});

const resultSchema = z.object({
  pages: z.array(pageSchema),
});

function displayTranslation(data: z.infer<typeof resultSchema>) {
  return data.pages
    .map((page) => {
      const lines = page.blocks.length
        ? page.blocks.map((b) => b.translation).join("\n")
        : "[NO TEXT]";
      return `[PAGE ${page.page}]\n${lines}`;
    })
    .join("\n\n");
}

export async function POST(request: Request) {
  let jobId = "";
  try {
    const body = await request.json();
    jobId = String(body?.jobId || "");
    const path = String(body?.path || "");
    const targetLanguage = String(body?.targetLanguage || "Uzbek");

    if (!jobId || !path || !path.startsWith(`jobs/${jobId}/source/`)) {
      return NextResponse.json({ error: "Noto'g'ri jobId yoki path" }, { status: 400 });
    }

    await supabaseAdmin.from("translation_jobs").update({
      status: "processing",
      error_message: null,
      updated_at: new Date().toISOString(),
    }).eq("id", jobId);

    const { data: signed, error: signedError } = await supabaseAdmin.storage
      .from(BUCKET).createSignedUrl(path, 60 * 60);

    if (signedError || !signed?.signedUrl) {
      throw new Error(`PDF uchun vaqtinchalik URL yaratilmadi: ${signedError?.message || "unknown"}`);
    }

    const result = await generateText({
      model: "google/gemini-3.8-flash",
      output: Output.object({
        name: "MangaTranslationLayout",
        description: "Page-by-page manga translation with approximate text bounding boxes.",
        schema: resultSchema,
      }),
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: `You are a professional manga/manhwa translator and layout analyst.
Translate the attached PDF into ${targetLanguage}.
For every page, detect every readable dialogue bubble, narration box, caption, sign, label, and meaningful sound effect.
Return one block for each text region, preserving reading order.
The box_2d must be [ymin,xmin,ymax,xmax] normalized 0-1000, based on the visible PDF page.
Keep boxes reasonably tight around the original text region.
Preserve names, terminology, tone, and honorific meaning.
Do not summarize or invent text. If a page has no readable text, return an empty blocks array.
The translation must be natural Uzbek and suitable for placing back into the same region.`,
          },
          { type: "file", mediaType: "application/pdf", data: signed.signedUrl },
        ],
      }],
    });

    if (!result.output) throw new Error("AI strukturali tarjima natijasi bo'sh.");

    const translation = displayTranslation(result.output);

    const { error: saveError } = await supabaseAdmin.from("translation_jobs").update({
      status: "completed",
      translation,
      translation_json: result.output,
      updated_at: new Date().toISOString(),
    }).eq("id", jobId);

    if (saveError) throw new Error(`Tarjima bazaga saqlanmadi: ${saveError.message}`);

    return NextResponse.json({
      ok: true,
      jobId,
      targetLanguage,
      translation,
      layout: result.output,
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
    console.error("translation_pipeline_error", error);
    return NextResponse.json({ error: "AI tarjima pipeline xatosi", detail: message }, { status: 500 });
  }
}
