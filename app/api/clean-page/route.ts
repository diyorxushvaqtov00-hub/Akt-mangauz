import { NextResponse } from "next/server";

export const maxDuration = 60;

type CleanBlock = {
  source?: string;
  box_2d?: number[];
  type?: string;
};

function clampNumber(value: unknown, min: number, max: number) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

function normalizeImageInput(value: unknown) {
  if (typeof value !== "string") return null;
  const match = value.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  const mimeType = match[1] === "image/jpg" ? "image/jpeg" : match[1];
  return { mimeType, data: match[2] };
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const image = normalizeImageInput(body?.image);
    const mask = normalizeImageInput(body?.mask);
    const blocks = Array.isArray(body?.blocks) ? body.blocks as CleanBlock[] : [];

    if (!image) {
      return NextResponse.json({ error: "Valid page image kerak." }, { status: 400 });
    }

    if (!mask) {
      return NextResponse.json({ error: "Cleanup mask kerak." }, { status: 400 });
    }

    if (!blocks.length) {
      return NextResponse.json({ ok: true, image: body.image, skipped: true });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "GEMINI_API_KEY Vercel Environment Variables'da topilmadi." },
        { status: 500 },
      );
    }

    const regions = blocks
      .map((block, index) => {
        const box = Array.isArray(block.box_2d) ? block.box_2d.map(Number) : [];
        if (box.length !== 4 || !box.every(Number.isFinite)) return null;

        const [top, left, bottom, right] = box.map((value) =>
          clampNumber(value, 0, 1000),
        );

        return {
          id: index + 1,
          type: typeof block.type === "string" ? block.type : "text",
          source: typeof block.source === "string" ? block.source : "",
          box_2d: [top, left, bottom, right],
        };
      })
      .filter(Boolean);

    if (!regions.length) {
      return NextResponse.json({ ok: true, image: body.image, skipped: true });
    }

    const prompt = `You are a professional manga lettering removal and inpainting engine. Perform a REAL image edit, not a new illustration.

INPUTS:
- IMAGE 1 is the original manga page.
- IMAGE 2 is a binary cleanup mask generated from the OCR regions.
- In the mask, WHITE pixels are the ONLY editable regions. BLACK pixels are protected and MUST remain unchanged.

PRIMARY GOAL:
Remove the original lettering completely from every WHITE mask region, reconstructing whatever artwork, bubble fill, screentone, gradient, or texture was behind the letters. Do not add any replacement text.

MASK RULES:
- Treat the WHITE mask as authoritative. Edit only inside white pixels.
- Do not edit, redraw, sharpen, recolor, crop, resize, or reinterpret any BLACK mask area.
- Never ignore the mask and never use the whole page as an editable region.
- The mask includes complete OCR text boxes/polygons, so remove ALL original glyphs inside those white regions.
- Do not blur, fade, paint over, or lower opacity of the original letters. The original glyph shapes must be reconstructed away.
- For white lettering on a dark bubble, reconstruct the same dark bubble fill.
- For black lettering on a white/light bubble or page, reconstruct the surrounding white/light fill.
- For lettering over line art, continue the exact nearby line art through the removed glyph area.
- Preserve halftone dots, screentones, gradients, panel borders, characters, faces, hair, clothing, objects, lighting, shadows, and composition.
- Do not translate, typeset, or insert Uzbek text.
- Keep the exact page aspect ratio and composition.
- Return one edited image.

TARGET REGIONS (for semantic context only; the mask is authoritative):
__REGIONS__
`;

    const finalPrompt = prompt.replace("__REGIONS__", JSON.stringify(regions));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 50_000);

    try {
      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/interactions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey,
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: "gemini-3.1-flash-image",
            input: [
              { type: "image", mime_type: image.mimeType, data: image.data },
              { type: "image", mime_type: mask.mimeType, data: mask.data },
              { type: "text", text: finalPrompt },
            ],
            response_format: { type: "image", mime_type: "image/jpeg", image_size: "2K" },
          }),
        },
      );

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        const message =
          data?.error?.message ||
          data?.error?.status ||
          `Gemini image edit HTTP ${response.status}`;
        return NextResponse.json(
          { error: message, retryable: response.status === 429 || response.status >= 500 },
          { status: response.status },
        );
      }

      const outputImage =
        typeof data?.output_image?.data === "string"
          ? data.output_image.data
          : Array.isArray(data?.steps)
            ? data.steps
                .flatMap((step: any) =>
                  step?.type === "model_output" && Array.isArray(step?.content)
                    ? step.content
                    : [],
                )
                .find((part: any) => part?.type === "image" && typeof part?.data === "string")
                ?.data
            : null;

      if (!outputImage) {
        return NextResponse.json(
          { error: "Gemini tozalangan sahifa rasmini qaytarmadi.", retryable: true },
          { status: 502 },
        );
      }

      return NextResponse.json({
        ok: true,
        image: `data:image/jpeg;base64,${outputImage}`,
        model: "gemini-3.1-flash-image",
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "Sahifani tozalash 50 soniyadan oshdi."
        : error instanceof Error
          ? error.message
          : "Sahifani tozalash xatosi";

    return NextResponse.json({ error: message, retryable: true }, { status: 500 });
  }
}
