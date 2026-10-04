import { NextResponse } from "next/server";
import { generateText } from "ai";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const maxDuration = 60;

const BUCKET = "manga-files";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const jobId = String(body?.jobId || "");
    const path = String(body?.path || "");
    const targetLanguage = String(body?.targetLanguage || "Uzbek");

    if (!jobId || !path || !path.startsWith(`jobs/${jobId}/source/`)) {
      return NextResponse.json({ error: "Noto'g'ri jobId yoki path" }, { status: 400 });
    }

    const { data: signed, error: signedError } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUrl(path, 60 * 60);

    if (signedError || !signed?.signedUrl) {
      return NextResponse.json(
        { error: "PDF uchun vaqtinchalik URL yaratilmadi", detail: signedError?.message },
        { status: 500 }
      );
    }

    const result = await generateText({
      model: "google/gemini-3.8-flash",
      messages: [
        {
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
This is an intermediate translation result; do not invent missing dialogue.`,
            },
            {
              type: "file",
              mediaType: "application/pdf",
              data: signed.signedUrl,
            },
          ],
        },
      ],
      providerOptions: {
        gateway: {
          tags: ["feature:manga-translation", "env:production"],
        },
      },
    });

    return NextResponse.json({
      ok: true,
      jobId,
      targetLanguage,
      translation: result.text,
    });
  } catch (error) {
    console.error("translation_pipeline_error", error);
    return NextResponse.json(
      {
        error: "AI tarjima pipeline xatosi",
        detail: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
