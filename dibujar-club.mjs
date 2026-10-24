// Dibujante de Inmoescala Club (2026-10-23). Lo lanza GitHub Actions (workflow dibujar-club.yml) con una pieza:
// pide a Work el HTML (features/club-ei/ei-templates.ts), espera a que ajuste sus textos, saca una PNG de cada slide e
// historia, arma el video de la portada (la foto se acerca y se aleja despacio; el texto queda quieto) y le devuelve a
// Work los archivos y la revisión de espacios. Para probar sin Work: LOCAL_HTML=archivo.html OUT_DIR=carpeta.
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WORK = process.env.WORK_URL;
const SECRET = process.env.CAPTURER_SECRET;
const PIECE = process.env.PIECE_ID;
const RUN_URL = process.env.RUN_URL ?? null;
const LOCAL = process.env.LOCAL_HTML ?? null;
const OUT = process.env.OUT_DIR ?? null;
if (!LOCAL && (!WORK || !SECRET || !PIECE)) throw new Error("Faltan WORK_URL, CAPTURER_SECRET o PIECE_ID.");

async function api(method, query, body) {
  const res = await fetch(`${WORK}/api/agents/club/ei-render${query ?? ""}`, { method, headers: { "x-capturer-secret": SECRET, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(`Work respondió ${res.status}: ${json.error ?? "sin detalle"}`);
  return json;
}

async function save(name, buffer, contentType) {
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, name), buffer);
    return join(OUT, name);
  }
  const { signedUrl, publicUrl } = await api("POST", "", { op: "upload", id: PIECE, name });
  const res = await fetch(signedUrl, { method: "PUT", headers: { "Content-Type": contentType, "x-upsert": "true" }, body: buffer });
  if (!res.ok) throw new Error(`No se pudo subir ${name}: ${res.status} ${(await res.text()).slice(0, 120)}`);
  return publicUrl;
}

/** Video de 6 s: la foto se acerca hasta 7 % y vuelve (en bucle no se nota el corte); el texto va encima, quieto. */
function coverVideo(photo, text, out) {
  const r = spawnSync("ffmpeg", [
    "-y", "-loop", "1", "-framerate", "30", "-i", photo, "-loop", "1", "-framerate", "30", "-i", text,
    "-filter_complex", "[0:v]scale=2160:-1,zoompan=z='1+0.07*sin(PI*on/180)':x='iw/2-(iw/zoom/2)':y='ih*0.32-(ih*0.32/zoom)':d=1:s=1080x1440:fps=30[bg];[bg][1:v]overlay=0:0,format=yuv420p",
    "-t", "6", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart", "-an", out,
  ], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg falló: ${(r.stderr ?? "").slice(-400)}`);
}

async function main() {
  const html = LOCAL ? readFileSync(LOCAL, "utf8") : (await api("GET", `?op=html&id=${encodeURIComponent(PIECE)}`)).html;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 2000 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  const qa = await page.evaluate(() => window.__qa);
  const files = [];
  for (const shot of await page.$$(".shot")) {
    const name = await shot.getAttribute("data-name");
    const url = await save(name, await shot.screenshot({ type: "png" }), "image/png");
    files.push({ name, url, kind: name.startsWith("historia") ? "story" : "slide" });
  }
  // Capas del video de portada.
  const dir = mkdtempSync(join(tmpdir(), "ei-"));
  const cover = page.locator(".shot[data-cover]");
  if (await cover.count()) {
    await page.evaluate(() => document.documentElement.classList.add("layer-photo"));
    writeFileSync(join(dir, "photo.png"), await cover.screenshot({ type: "png" }));
    await page.evaluate(() => { document.documentElement.classList.remove("layer-photo"); document.documentElement.classList.add("layer-text"); });
    writeFileSync(join(dir, "text.png"), await cover.screenshot({ type: "png", omitBackground: true }));
    coverVideo(join(dir, "photo.png"), join(dir, "text.png"), join(dir, "cover.mp4"));
    const url = await save("01-portada.mp4", readFileSync(join(dir, "cover.mp4")), "video/mp4");
    files.unshift({ name: "01-portada.mp4", url, kind: "video" });
  }
  await browser.close();
  const problems = qa.flatMap((q) => q.problems.map((p) => `${q.name}: ${p}`));
  if (LOCAL) return console.log(JSON.stringify({ files: files.map((f) => f.name), problems }, null, 1));
  await api("POST", "", { op: "report", id: PIECE, status: "lista", files, qa: problems, runUrl: RUN_URL });
}

main().catch(async (err) => {
  console.error(err);
  if (!LOCAL) await api("POST", "", { op: "report", id: PIECE, status: "error", error: String(err?.message ?? err).slice(0, 300), runUrl: RUN_URL }).catch(() => null);
  process.exit(1);
});
