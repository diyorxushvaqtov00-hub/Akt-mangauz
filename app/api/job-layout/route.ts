import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const jobId = String(body?.jobId || "");

    if (!jobId) {
      return NextResponse.json({ error: "jobId kerak." }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from("translation_jobs")
      .select("id,status,translation_json,total_pages")
      .eq("id", jobId)
      .single();

    if (error || !data) {
      return NextResponse.json(
        { error: error?.message || "Job topilmadi." },
        { status: 404 },
      );
    }

    if (!data.translation_json) {
      return NextResponse.json(
        { error: "Tarjima layouti hali tayyor emas." },
        { status: 409 },
      );
    }

    return NextResponse.json({
      ok: true,
      layout: data.translation_json,
      status: data.status,
      totalPages: data.total_pages,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Layout olish xatosi.",
      },
      { status: 500 },
    );
  }
}
