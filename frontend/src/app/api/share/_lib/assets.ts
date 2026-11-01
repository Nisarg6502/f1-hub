import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDriverImagePath } from "@/lib/driver-images";

/**
 * Fonts and portraits for the share cards, read from disk.
 *
 * **Fonts.** Satori needs the raw bytes of every face it draws — it cannot
 * read the page's `next/font` CSS, and `woff2` (all `next/font` emits) is not
 * a format it parses. So the two brand families are committed as static TTF
 * instances in `frontend/assets/fonts/`, both under the SIL Open Font License
 * (the licence files sit beside them). Static instances, not the variable
 * fonts, because Satori draws a variable font at its default axis position
 * and every weight would come out the same.
 *
 * The path is built as `join(process.cwd(), "assets/…")` with literal
 * segments, which is the shape Next's output tracing recognises (see the
 * `ImageResponse` docs) — that is what copies the files into
 * `.next/standalone` for the Docker image. A computed filename would build
 * and then fail at runtime in production only.
 *
 * Read once per process and kept: the promise is cached, so concurrent first
 * requests share one read and a later request pays nothing.
 *
 * **Portraits.** Read from `public/drivers/`, which the Dockerfile copies into
 * the runtime image, rather than fetched from the asset bucket. A card render
 * that makes its own outbound request per driver is slower, can fail
 * independently of the data it is drawing, and would make the image depend
 * on a second service being up.
 */

export type CardFont = {
  name: string;
  data: Buffer;
  weight: 500 | 700 | 800;
  style: "normal";
};

let fontsPromise: Promise<CardFont[]> | null = null;

export function loadCardFonts(): Promise<CardFont[]> {
  if (!fontsPromise) {
    const dir = join(process.cwd(), "assets", "fonts");
    fontsPromise = Promise.all([
      readFile(join(dir, "BricolageGrotesque-Bold.ttf")),
      readFile(join(dir, "BricolageGrotesque-ExtraBold.ttf")),
      readFile(join(dir, "HankenGrotesk-Medium.ttf")),
      readFile(join(dir, "HankenGrotesk-Bold.ttf")),
      readFile(join(dir, "HankenGrotesk-ExtraBold.ttf")),
    ]).then(([bricolageBold, bricolageXBold, hankenMedium, hankenBold, hankenXBold]) => [
      { name: "Bricolage Grotesque", data: bricolageBold, weight: 700, style: "normal" },
      { name: "Bricolage Grotesque", data: bricolageXBold, weight: 800, style: "normal" },
      { name: "Hanken Grotesk", data: hankenMedium, weight: 500, style: "normal" },
      { name: "Hanken Grotesk", data: hankenBold, weight: 700, style: "normal" },
      { name: "Hanken Grotesk", data: hankenXBold, weight: 800, style: "normal" },
    ]);
    // A failed read must not be cached forever — the next request retries.
    fontsPromise.catch(() => {
      fontsPromise = null;
    });
  }
  return fontsPromise;
}

/**
 * The band of each cutout a card ever shows, in source rows, and the width it
 * is resampled to.
 *
 * Every frame the cards use ends above row 520 (`FRAME_BANDS` in
 * `driver-portrait.ts`: `bust` at 440, `figure` at 520), so the legs — 60% of
 * each file — are cut before encoding. 300px wide covers the largest box a
 * card draws a portrait into (the portrait-format leader panel, ~277px of
 * rendered image width) without upscaling.
 */
export const PORTRAIT_CROP_ROWS = 560;
const PORTRAIT_OUT_WIDTH = 300;

const portraitCache = new Map<string, Promise<string | null>>();

/**
 * A driver's cutout as a PNG `data:` URI, or `null` when there is no
 * portrait to show. The card draws initials on the team colour instead.
 *
 * **The files are WebP**, despite the `.png` names — `RIFF…WEBPVP8X` on disk
 * and in the bucket, served as `image/png`, which browsers forgive by
 * sniffing. Satori does not: it decodes PNG, JPEG and GIF only, and a WebP
 * `src` renders as an empty box with no error. So each file is transcoded
 * once per process with `sharp` — already installed as Next's own image
 * optimiser, and present in the standalone build for the same reason — and
 * cropped to the band the cards use.
 *
 * `null` covers both "no portrait in the asset set" (most of the 2018–2021
 * grid, any mid-season debutant) and "sharp could not load", so a missing
 * native binary degrades to initials rather than failing the card.
 *
 * The file is located through `getDriverImagePath` so the name-matching
 * rules — diacritics, "Andrea Kimi" → `Kimi_Antonelli` — are the page's own,
 * not a second copy that could disagree about who has a photo.
 */
export function loadDriverPortrait(givenName: string, familyName: string): Promise<string | null> {
  const path = getDriverImagePath(givenName, familyName);
  const file = path?.split("/").pop();
  if (!file || !/^[A-Za-z_]+\.png$/.test(file)) return Promise.resolve(null);
  let cached = portraitCache.get(file);
  if (!cached) {
    cached = (async () => {
      try {
        const source = await readFile(join(process.cwd(), "public", "drivers", file));
        const sharp = (await import("sharp")).default;
        const image = sharp(source);
        const { width = 0, height = 0 } = await image.metadata();
        if (!width || !height) return null;
        const png = await image
          .extract({ left: 0, top: 0, width, height: Math.min(height, PORTRAIT_CROP_ROWS) })
          .resize({ width: PORTRAIT_OUT_WIDTH })
          .png({ compressionLevel: 9 })
          .toBuffer();
        return `data:image/png;base64,${png.toString("base64")}`;
      } catch {
        return null;
      }
    })();
    portraitCache.set(file, cached);
  }
  return cached;
}
