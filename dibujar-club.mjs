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

/** Video de 6 s: la foto se acerca hasta 6 % y vuelve, suave (en bucle no se nota el corte); el texto va encima, quieto. */
function coverVideo(photo, text, out) {
  const r = spawnSync("ffmpeg", [
    "-y", "-loop", "1", "-framerate", "30", "-i", photo, "-loop", "1", "-framerate", "30", "-i", text,
    // Se calcula sobre la foto 4 veces más grande (pasos de ¼ de píxel, sin temblor) y con curva suave (arranca y frena
    // despacio), así el bucle no se nota. Acercamiento máximo 6 %, con el foco a un tercio de la altura.
    "-filter_complex", "[0:v]scale=4320:-1:flags=lanczos,zoompan=z='1+0.06*(1-cos(2*PI*on/180))/2':x='iw/2-(iw/zoom/2)':y='ih*0.32-(ih*0.32/zoom)':d=1:s=1080x1440:fps=30[bg];[bg][1:v]overlay=0:0,format=yuv420p",
    "-t", "6", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-movflags", "+faststart", "-an", out,
  ], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg falló: ${(r.stderr ?? "").slice(-400)}`);
}

function ff(args) {
  const r = spawnSync("ffmpeg", ["-loglevel", "error", "-y", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg falló: ${(r.stderr ?? "").slice(-500)}`);
}

/**
 * Reel b-roll del Club (2026-10-25). Work manda las capas (velo, texto, tarjetas, insignia y la máscara del vidrio) como
 * cuadros transparentes de 1080×1920 y el plan de tiempos en window.__reel. Se bajan las tomas, se cortan y se pegan,
 * se pone el vidrio desenfocado debajo de la tarjeta y cada capa entra con un fundido corto y sube unos px.
 * Hilos limitados: ffmpeg con muchas entradas de imagen se queda sin memoria si no.
 */
async function reel(page, spec, dir) {
  const W = 1080, H = 1920;
  const base = `scale=${W}:${H}:force_original_aspect_ratio=increase:flags=lanczos,crop=${W}:${H},fps=30,setsar=1,unsharp=5:5:0.5`;
  // 1) Las capas, cada una con su transparencia.
  const layerFile = {};
  for (const el of await page.$$(".layer[data-name]")) {
    const name = await el.getAttribute("data-name");
    const file = join(dir, `${name}.png`);
    writeFileSync(file, await el.screenshot({ type: "png", omitBackground: name !== "mask" }));
    layerFile[name] = file;
  }
  // 2) Las tomas: se bajan una vez y se cortan.
  const got = {};
  const segs = [];
  for (const [i, c] of spec.cuts.entries()) {
    if (!got[c.url]) {
      const res = await fetch(c.url);
      if (!res.ok) throw new Error(`No se pudo bajar la toma (${res.status}).`);
      got[c.url] = join(dir, `toma-${Object.keys(got).length}.mp4`);
      writeFileSync(got[c.url], Buffer.from(await res.arrayBuffer()));
    }
    const seg = join(dir, `corte-${i}.mp4`);
    ff(["-ss", String(c.from), "-t", String(c.dur), "-i", got[c.url], "-vf", base, "-an", "-c:v", "libx264", "-threads", "2", "-crf", "16", "-pix_fmt", "yuv420p", seg]);
    segs.push(seg);
  }
  const list = join(dir, "cortes.txt");
  writeFileSync(list, segs.map((s) => `file '${s.replace(/\\/g, "/")}'`).join("\n"));
  const joined = join(dir, "base.mp4");
  ff(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", joined]);
  // 3) La composición.
  const loop = (file) => ["-loop", "1", "-framerate", "30", "-t", String(spec.duration + 1), "-i", file];
  const inputs = ["-i", joined];
  let n = 1;
  let f = `[0:v]trim=0:${spec.duration},setpts=PTS-STARTPTS`;
  let last;
  if (spec.glass && layerFile.mask) {
    inputs.push(...loop(layerFile.mask));
    f += `,split[a][b];[b]gblur=sigma=26,eq=brightness=0.02[bl];[${n}:v]format=gray[m];[bl][m]alphamerge[glass];[a][glass]overlay=0:0:enable='between(t,${spec.glass.start},${spec.glass.end})'[v0];`;
    n++;
  } else f += `[v0];`;
  last = "[v0]";
  for (const [i, l] of spec.layers.entries()) {
    if (!layerFile[l.name]) continue;
    inputs.push(...loop(layerFile[l.name]));
    const fade = l.fade > 0 ? `,fade=in:st=${l.start}:d=${l.fade}:alpha=1` : "";
    const y = l.rise > 0 ? `'${l.rise}*max(0\\,1-(t-${l.start})/0.2)'` : "0";
    f += `[${n}:v]format=rgba${fade}[c${i}];${last}[c${i}]overlay=x=0:y=${y}:enable='between(t,${l.start},${l.end})'[v${i + 1}];`;
    last = `[v${i + 1}]`;
    n++;
  }
  f = f.replace(/;$/, "");
  const out = join(dir, "reel.mp4");
  ff([...inputs, "-filter_complex", f, "-map", last, "-t", String(spec.duration), "-c:v", "libx264", "-threads", "4", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", out]);
  const poster = join(dir, "portada.png");
  ff(["-ss", String(spec.poster), "-i", out, "-frames:v", "1", poster]);
  return { video: out, poster };
}

async function main() {
  const html = LOCAL ? readFileSync(LOCAL, "utf8") : (await api("GET", `?op=html&id=${encodeURIComponent(PIECE)}`)).html;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 2000 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "networkidle", timeout: 90000 });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });
  const qa = await page.evaluate(() => window.__qa);
  const files = [];
  // Reel b-roll: un video sobre la toma del banco (y su portada).
  const spec = await page.evaluate(() => window.__reel ?? null);
  if (spec) {
    const dir = mkdtempSync(join(tmpdir(), "reel-"));
    const { video, poster } = await reel(page, spec, dir);
    await browser.close();
    files.push({ name: "01-reel.mp4", url: await save("01-reel.mp4", readFileSync(video), "video/mp4"), kind: "video" });
    files.push({ name: "02-portada.png", url: await save("02-portada.png", readFileSync(poster), "image/png"), kind: "slide" });
    const problems = qa.flatMap((q) => q.problems.map((p) => `${q.name}: ${p}`));
    if (LOCAL) return console.log(JSON.stringify({ files: files.map((f) => f.url), problems }, null, 1));
    // Un texto fuera de la zona segura no llega a Kristel: vuelve como error con el motivo.
    if (problems.length) return api("POST", "", { op: "report", id: PIECE, status: "error", error: `Revisa el reel: ${problems.join(" · ")}`.slice(0, 300), runUrl: RUN_URL });
    return api("POST", "", { op: "report", id: PIECE, status: "lista", files, qa: [], runUrl: RUN_URL });
  }
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
