import { JSDOM } from "jsdom";
import postcss from "postcss";
import { remoteImageUrl, safeEmailLink } from "./sanitize-email-html";

export const SAFE_INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);
export function isSafeRaster(bytes: Uint8Array, type: string) {
  const ascii = (start: number, end: number) =>
    String.fromCharCode(...bytes.subarray(start, end));
  if (type === "image/png")
    return [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b);
  if (type === "image/jpeg")
    return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (type === "image/gif") return ["GIF87a", "GIF89a"].includes(ascii(0, 6));
  if (type === "image/webp")
    return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  if (type === "image/avif")
    return ascii(4, 8) === "ftyp" && ["avif", "avis"].includes(ascii(8, 12));
  return false;
}

/** Generic CID resources may render only as an already-supported raster. */
export function inlineRasterType(bytes: Uint8Array, declaredType: string) {
  if (declaredType === "application/octet-stream") {
    for (const type of SAFE_INLINE_IMAGE_TYPES)
      if (isSafeRaster(bytes, type)) return type;
    return null;
  }
  return SAFE_INLINE_IMAGE_TYPES.has(declaredType) &&
    isSafeRaster(bytes, declaredType)
    ? declaredType
    : null;
}

export const EMAIL_BASE_CSS =
  "html{color-scheme:only light;background:#fff;color:#20242b}body{background:#fff;color:#20242b;font:15px/1.55 Arial,sans-serif;margin:16px;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%!important}body>table{width:100%!important}td,th{overflow-wrap:anywhere}pre{white-space:pre-wrap}a{overflow-wrap:anywhere}";

/** Input must be produced by email-html-v2. Activate only validated links/images
 * and use the sender's light color variant in the isolated light canvas.
 * The CSP precedes all sender markup and remains restrictive under permission.
 */
export function renderEmailDocument(
  html: string,
  allowRemote: boolean,
  cidImages: ReadonlyMap<string, string> = new Map(),
) {
  const dom = new JSDOM(html);
  try {
    const document = dom.window.document;
    for (const style of document.querySelectorAll("style")) {
      const sheet = postcss.parse(style.textContent ?? "");
      sheet.walkAtRules("media", (rule) => {
        // Browser media preferences can follow the dark embedding document even
        // with a light iframe color-scheme. Evaluate just color preferences as
        // light while retaining responsive conditions, lists and negation.
        rule.params = rule.params
          .replace(
            /\(\s*prefers-color-scheme\s*:\s*dark\s*\)/gi,
            "(max-width: -1px)",
          )
          .replace(
            /\(\s*prefers-color-scheme\s*:\s*light\s*\)/gi,
            "(min-width: 0px)",
          );
      });
      style.textContent = sheet.toString();
    }
    for (const img of document.querySelectorAll("img")) {
      img.removeAttribute("src");
      const remote = remoteImageUrl(
        img.getAttribute("data-maildock-remote") ?? "",
      );
      const cid = cidImages.get(img.getAttribute("data-maildock-cid") ?? "");
      if (
        cid &&
        /^data:image\/(?:png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/=]+$/.test(
          cid,
        )
      )
        img.setAttribute("src", cid);
      else if (allowRemote && remote) img.setAttribute("src", remote);
      img.removeAttribute("data-maildock-remote");
      img.removeAttribute("data-maildock-cid");
    }
    for (const link of document.querySelectorAll("a")) {
      const href = safeEmailLink(link.getAttribute("href") ?? "");
      if (href) {
        link.setAttribute("href", href);
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer");
        link.setAttribute("referrerpolicy", "no-referrer");
      } else link.removeAttribute("href");
    }
    const csp = `default-src 'none'; script-src 'none'; object-src 'none'; frame-src 'none'; connect-src 'none'; img-src data:${allowRemote ? " https: http:" : ""}; media-src 'none'; font-src 'none'; form-action 'none'; base-uri 'none'; style-src 'unsafe-inline'`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>${EMAIL_BASE_CSS}</style>${[...document.head.querySelectorAll("style")].map((s) => s.outerHTML).join("")}</head><body>${document.body.innerHTML}</body></html>`;
  } finally {
    dom.window.close();
  }
}
