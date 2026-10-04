import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-admin";

const BUCKET = "manga-files";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const name = typeof body.name === "string" ? body.name : "";
    const size = Number(body.size);

    if (!name.toLowerCase().endsWith(".pdf")) return NextResponse.json({ error: "Faqat PDF fayl qabul qilinadi." }, { status: 400 });
    if (!Number.isFinite(size) || size <= 0 || size > 100 * 1024 * 1024) return NextResponse.json({ error: "PDF hajmi 100 MB dan oshmasligi kerak." }, { status: 400 });

    const id = randomUUID();
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const path = "jobs/" + id + "/source/" + safeName;

    const { error: jobError } = await supabaseAdmin.from("translation_jobs").insert({
      id, filename: name, source_path: path, source_name: name, target_language: "Uzbek", status: "uploaded",
    });
    if (jobError) return NextResponse.json({ error: "Job yaratilmadi.", details: jobError.message }, { status: 500 });

    const { data, error } = await supabaseAdmin.storage.from(BUCKET).createSignedUploadUrl(path);
    if (error) {
      await supabaseAdmin.from("translation_jobs").update({ status: "failed", error_message: error.message }).eq("id", id);
      return NextResponse.json({ error: "Upload URL yaratib bo‘lmadi.", details: error.message }, { status: 500 });
    }

    return NextResponse.json({ jobId: id, path, token: data.token, signedUrl: data.signedUrl });
  } catch {
    return NextResponse.json({ error: "Noto‘g‘ri so‘rov." }, { status: 400 });
  }
}
