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
    const blocks = Array.isArray(body?.blocks) ? body.blocks as CleanBlock[] : [];

    if (!image) {
      return NextResponse.json({ error: "Valid page image kerak." }, { status: 400 });
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

    const prompt = `You are a professional manga/manhwa clean-up editor.

EDIT ONLY THE ORIGINAL TEXT REGIONS listed below.

Goal:
1. Remove the original lettering completely.
2. Reconstruct the exact background underneath the lettering.
3. Preserve the original artwork as faithfully as possible.

ABSOLUTE PROTECTION RULES:
- Do NOT redraw, restyle, sharpen, recolor, or reinterpret the page.
- Do NOT change characters, faces, hair, clothes, objects, panel borders, speech-bubble shapes, lighting, shadows, textures, or composition.
- Do NOT add new artwork.
- Do NOT translate or insert any replacement text.
- Do NOT leave any original readable lettering inside the listed regions.
- Keep all pixels outside the original text regions visually unchanged.
- If a region is a speech bubble, preserve the bubble shape and its original fill color.
- If a region is black/dark with white lettering, reconstruct the dark/black area and remove only the lettering.
- If a region lies over artwork, reconstruct only the tiny area occupied by the lettering using the surrounding artwork.
- Preserve halftone dots, line art, gradients, and texture whenever possible.

The normalized coordinates use [top, left, bottom, right], each from 0 to 1000.

TARGET REGIONS:
__REGIONS__

Return ONE edited image of the same page with the same aspect ratio and composition.
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
              { type: "text", text: finalPrompt },
            ],
            response_format: { type: "image", mime_type: "image/png" },
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
        image: `data:image/png;base64,${outputImage}`,
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
