import { NextResponse } from "next/server";
import { generateText } from "ai";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const maxDuration = 60;

const BUCKET = "manga-files";

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
      status: "processing", error_message: null, updated_at: new Date().toISOString(),
    }).eq("id", jobId);

    const { data: signed, error: signedError } = await supabaseAdmin.storage
      .from(BUCKET).createSignedUrl(path, 60 * 60);

    if (signedError || !signed?.signedUrl) {
      throw new Error(`PDF uchun vaqtinchalik URL yaratilmadi: ${signedError?.message || "unknown"}`);
    }

    const result = await generateText({
      model: "google/gemini-3.8-flash",
      messages: [{
        role: "user",
        content: [
          {
            type: "text",
            text: `You are a professional manga/manhwa translator.
Translate the attached PDF into ${targetLanguage}.
Preserve character names, terminology, tone, honorific meaning, dialogue order, and sound-effect meaning.
Do not summarize. Translate the actual readable text.
Return clean page-by-page translated text with clear markers such as [PAGE 1], [PAGE 2].
If a page contains no readable text, write [NO TEXT].
Do not invent missing dialogue.`,
          },
          { type: "file", mediaType: "application/pdf", data: signed.signedUrl },
        ],
      }],
    });

    await supabaseAdmin.from("translation_jobs").update({
      status: "completed", translation: result.text, updated_at: new Date().toISOString(),
    }).eq("id", jobId);

    return NextResponse.json({ ok: true, jobId, targetLanguage, translation: result.text });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (jobId) {
      await supabaseAdmin.from("translation_jobs").update({
        status: "failed", error_message: message, updated_at: new Date().toISOString(),
      }).eq("id", jobId);
    }
    console.error("translation_pipeline_error", error);
    return NextResponse.json({ error: "AI tarjima pipeline xatosi", detail: message }, { status: 500 });
  }
}
