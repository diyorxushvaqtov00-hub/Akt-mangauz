import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

const BUCKET = "manga-files";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const path = typeof body.path === "string" ? body.path : "";
    const jobId = typeof body.jobId === "string" ? body.jobId : "";

    if (!path || !jobId || !path.startsWith("jobs/" + jobId + "/source/")) {
      return NextResponse.json({ error: "Upload ma’lumotlari noto‘g‘ri." }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin.storage.from(BUCKET).list("jobs/" + jobId + "/source");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const fileName = path.split("/").pop();
    if (!data?.some((item) => item.name === fileName)) {
      return NextResponse.json({ error: "PDF Storage'da topilmadi." }, { status: 404 });
    }

    return NextResponse.json({ ok: true, jobId, path });
  } catch {
    return NextResponse.json({ error: "Noto‘g‘ri so‘rov." }, { status: 400 });
  }
}
