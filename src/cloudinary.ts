/**
 * Cloudinary helpers — generic post-processing for any workflow.
 *
 * The functions here build Cloudinary delivery URLs; they don't talk
 * to the Cloudinary API for actual processing. Cloudinary applies the
 * transform on the fly when the URL is fetched, so output is just a
 * URL the app stores or hands to the browser.
 *
 * For uploads (storing arbitrary URLs into the consuming app's
 * Cloudinary cloud), use Cloudinary's signed-upload from the browser
 * directly — no need to route through the engine.
 *
 * Required env in the consuming app: CLOUDINARY_CLOUD_NAME
 * (or pass cloudName per-call).
 */

export type ApplyCloudinaryTransformOpts = {
  /** Source image URL — any public HTTPS URL Cloudinary can fetch. */
  sourceUrl: string;
  /** Cloudinary transformation string, e.g.
   *  "l_text:Arial_36_bold:goober.tw,co_rgb:374151,o_80,g_south_east,x_30,y_30"
   *  for a watermark, or "e_background_removal" for bg-removal. */
  transform: string;
  /** Cloud name — falls back to env CLOUDINARY_CLOUD_NAME. */
  cloudName?: string;
};

/**
 * Wraps a public URL in Cloudinary's `fetch` delivery type and applies
 * the given transformation. Returns the new URL.
 *
 * Output URL shape:
 *   https://res.cloudinary.com/{cloud}/image/fetch/{transform}/{encoded_source_url}
 */
export function applyCloudinaryTransform(
  opts: ApplyCloudinaryTransformOpts,
): string {
  const cloudName = opts.cloudName ?? process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName) {
    throw new Error(
      "CLOUDINARY_CLOUD_NAME is not set. Pass cloudName explicitly, or set the env var.",
    );
  }
  const encoded = encodeURIComponent(opts.sourceUrl);
  return `https://res.cloudinary.com/${cloudName}/image/fetch/${opts.transform}/${encoded}`;
}

/**
 * Convenience wrappers for the two transforms most workflows want.
 * If you need anything more exotic, call applyCloudinaryTransform directly
 * with a custom transform string.
 */

export function buildWatermarkTransform(opts: {
  /** Text to overlay (e.g. "goober.tw"). */
  text: string;
  /** Font size in px. Default 36. */
  fontSize?: number;
  /** Hex color without `#`. Default "374151" (slate-700). */
  color?: string;
  /** 0-100. Default 80. */
  opacity?: number;
  /** Cloudinary gravity. Default "south_east" (bottom-right). */
  gravity?: "south_east" | "south_west" | "north_east" | "north_west" | "center";
  /** Padding from edge in px. Default 30. */
  padding?: number;
}): string {
  const fontSize = opts.fontSize ?? 36;
  const color = opts.color ?? "374151";
  const opacity = opts.opacity ?? 80;
  const gravity = opts.gravity ?? "south_east";
  const padding = opts.padding ?? 30;
  // Cloudinary text overlays need URL-safe text — colons must be encoded
  const safeText = opts.text.replace(/:/g, "%3A").replace(/,/g, "%2C");
  return `l_text:Arial_${fontSize}_bold:${safeText},co_rgb:${color},o_${opacity},g_${gravity},x_${padding},y_${padding}`;
}

export const BG_REMOVAL_TRANSFORM = "e_background_removal";
