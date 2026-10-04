import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const maxDuration = 60;

const BUCKET = "manga-files";
const GEMINI_MODEL = "gemini-3.8-flash";

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

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY Vercel Environment Variables'da topilmadi.");
    }

    await supabaseAdmin.from("translation_jobs").update({
      status: "processing",
      error_message: null,
      updated_at: new Date().toISOString(),
    }).eq("id", jobId);

    const { data: signed, error: signedError } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUrl(path, 60 * 60);

    if (signedError || !signed?.signedUrl) {
      throw new Error(`PDF uchun vaqtinchalik URL yaratilmadi: ${signedError?.message || "unknown"}`);
    }

    const pdfResponse = await fetch(signed.signedUrl);
    if (!pdfResponse.ok) {
      throw new Error(`PDF Storage'dan olinmadi: HTTP ${pdfResponse.status}`);
    }

    const pdfBytes = new Uint8Array(await pdfResponse.arrayBuffer());
    if (pdfBytes.byteLength > 45 * 1024 * 1024) {
      throw new Error("Test uchun PDF 45 MB dan kichik bo‘lishi kerak.");
    }

    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < pdfBytes.length; i += chunkSize) {
      binary += String.fromCharCode(...pdfBytes.subarray(i, i + chunkSize));
    }
    const pdfBase64 = btoa(binary);

    const prompt = `You are a professional manga/manhwa translator.
Translate the attached PDF into ${targetLanguage}.
Preserve character names, terminology, tone, honorific meaning, dialogue order, and sound-effect meaning.
Do not summarize. Translate the actual readable text.
Return clean page-by-page translated text with clear markers such as [PAGE 1], [PAGE 2].
If a page contains no readable text, write [NO TEXT].
Do not invent missing dialogue.`;

    const geminiResponse = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{
            role: "user",
            parts: [
              { text: prompt },
              { inlineData: { mimeType: "application/pdf", data: pdfBase64 } },
            ],
          }],
          generationConfig: {
            temperature: 0.2,
          },
        }),
      },
    );

    const geminiData = await geminiResponse.json();

    if (!geminiResponse.ok) {
      const apiMessage =
        geminiData?.error?.message ||
        geminiData?.error?.status ||
        `Gemini API HTTP ${geminiResponse.status}`;
      throw new Error(apiMessage);
    }

    const translation = geminiData?.candidates?.[0]?.content?.parts
      ?.map((part: { text?: string }) => part.text || "")
      .join("")
      .trim();

    if (!translation) {
      throw new Error("Gemini javobida tarjima matni topilmadi.");
    }

    const { error: updateError } = await supabaseAdmin.from("translation_jobs").update({
      status: "completed",
      translation,
      updated_at: new Date().toISOString(),
    }).eq("id", jobId);

    if (updateError) {
      throw new Error(`Tarjima saqlanmadi: ${updateError.message}`);
    }

    return NextResponse.json({
      ok: true,
      jobId,
      targetLanguage,
      translation,
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
    return NextResponse.json({
      error: "AI tarjima pipeline xatosi",
      detail: message,
    }, { status: 500 });
  }
}
