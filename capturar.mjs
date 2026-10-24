// Runner del capturador de Work (2026-10-11). Lo lanza GitHub Actions con un
// trabajo: "login" (entra a la cuenta demo con el código que Billie pega en
// Work y guarda la sesión) o "capture" (sigue una receta y sube capturas o
// video). Durante una captura bloquea todo lo que no sea leer: nunca crea,
// cambia ni gasta nada en la app.
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const WORK = process.env.WORK_URL;
const SECRET = process.env.CAPTURER_SECRET;
const JOB = process.env.JOB_ID;
const RUN_URL = process.env.RUN_URL ?? null;
if (!WORK || !SECRET || !JOB) throw new Error("Faltan WORK_URL, CAPTURER_SECRET o JOB_ID.");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(method, query, body) {
  const res = await fetch(`${WORK}/api/agents/capturer${query ?? ""}`, { method, headers: { "x-capturer-secret": SECRET, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.ok) throw new Error(`Work respondió ${res.status}: ${json.error ?? "sin detalle"}`);
  return json;
}
const report = (patch) => api("POST", "", { op: "report", id: JOB, ...patch });
const account = (app, patch) => api("POST", "", { op: "account", app, ...patch });

async function upload(name, buffer, contentType) {
  const { signedUrl, publicUrl } = await api("POST", "", { op: "upload", id: JOB, name });
  const res = await fetch(signedUrl, { method: "PUT", headers: { "Content-Type": contentType, "x-upsert": "true" }, body: buffer });
  if (!res.ok) throw new Error(`No se pudo subir ${name}: ${res.status} ${(await res.text()).slice(0, 120)}`);
  return publicUrl;
}

/** Cierra carteles de bienvenida, anuncios y recorridos que tapan la pantalla. */
async function dismissOverlays(page) {
  for (let round = 0; round < 3; round++) {
    let closed = false;
    for (const name of [/^cerrar$/i, /^omitir$/i, /^saltar$/i, /^entendido$/i, /^ahora no$/i, /^después$/i, /^listo$/i, /^×$/, /^✕$/]) {
      const b = page.getByRole("button", { name }).first();
      if (await b.isVisible({ timeout: 300 }).catch(() => false)) {
        await b.click({ timeout: 1500 }).catch(() => null);
        closed = true;
        await sleep(400);
      }
    }
    await page.keyboard.press("Escape").catch(() => null);
    if (!closed) break;
  }
}

async function login(browser, data) {
  const { app, account: acc } = data;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: "es-EC" });
  const page = await ctx.newPage();
  await page.goto(app.base + app.loginPath, { waitUntil: "domcontentloaded" });
  await page.locator(app.emailSelector).first().fill(acc.email);
  await page.locator(app.emailSelector).first().press("Enter");
  const codeBox = page.locator(app.codeSelector).first();
  await codeBox.waitFor({ state: "visible", timeout: 30000 }).catch(async () => {
    const text = (await page.locator("body").innerText().catch(() => "")).slice(0, 200);
    throw new Error(`La app no pidió el código. Lo que dice: ${text.replace(/\s+/g, " ")}`);
  });
  await account(data.job.app, { status: "esperando_codigo" });
  let code = null;
  for (let i = 0; i < 120 && !code; i++) {
    await sleep(5000);
    code = (await api("GET", `?op=code&app=${data.job.app}`)).code;
  }
  if (!code) throw new Error("Nadie pegó el código en 10 minutos.");
  await codeBox.fill(code);
  await codeBox.press("Enter");
  // Office: si el correo tiene más de una cuenta, elige la propia (la primera opción).
  await page.waitForURL((u) => !app.loginPaths.some((p) => u.pathname.startsWith(p)) || u.search.includes("paso=elegir"), { timeout: 60000 });
  if (page.url().includes("paso=elegir")) {
    await page.getByRole("button").first().click();
    await page.waitForURL((u) => !app.loginPaths.some((p) => u.pathname.startsWith(p)), { timeout: 60000 });
  }
  const state = await ctx.storageState();
  await account(data.job.app, { status: "conectada", state });
  await ctx.close();
  await report({ status: "lista", files: [] });
}

async function capture(browser, data) {
  const { app, recipe, viewport, account: acc } = data;
  if (!acc.state) {
    await account(data.job.app, { status: "vencida", error: "No hay sesión guardada." });
    throw new Error("La cuenta demo no tiene sesión: conéctala en Work.");
  }
  const forbidden = new RegExp(app.forbidden);
  const video = recipe.output === "video";
  const ctx = await browser.newContext({
    storageState: acc.state,
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.scale,
    locale: "es-EC",
    colorScheme: "light",
    ...(video ? { recordVideo: { dir: "videos", size: { width: viewport.width * 2, height: viewport.height * 2 } } } : {}),
  });
  // Solo leer: se bloquea todo pedido a la app que no sea GET (acciones, server actions, IA, envíos).
  const origin = new URL(app.base).origin;
  await ctx.route("**/*", (route) => {
    const req = route.request();
    if (new URL(req.url()).origin === origin && req.method() !== "GET") return route.abort();
    return route.continue();
  });
  const page = await ctx.newPage();
  const files = [];
  const isLogin = () => app.loginPaths.some((p) => new URL(page.url()).pathname.startsWith(p));
  for (const step of recipe.steps) {
    if (step.do === "goto") {
      if (forbidden.test(step.path.split("?")[0])) throw new Error(`Pantalla prohibida: ${step.path}`);
      await page.goto(app.base + step.path, { waitUntil: "networkidle", timeout: 45000 }).catch(() => page.waitForLoadState("domcontentloaded"));
      if (isLogin()) {
        await account(data.job.app, { status: "vencida", error: "La sesión venció." });
        throw new Error("La sesión de la cuenta demo venció: vuelve a conectarla en Work.");
      }
      await dismissOverlays(page);
    } else if (step.do === "wait") await sleep(Math.min(step.ms, 15000));
    else if (step.do === "waitFor") {
      const loc = step.selector ? page.locator(step.selector).first() : page.getByText(step.text ?? "").first();
      await loc.waitFor({ state: "visible", timeout: 20000 });
    } else if (step.do === "click") {
      const loc = step.selector ? page.locator(step.selector).first() : page.getByText(step.text ?? "").first();
      const ok = await loc.click({ timeout: 10000 }).then(() => true, () => false);
      if (!ok && !step.optional) throw new Error(`No encontré dónde tocar (${step.selector ?? step.text}).`);
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
      await dismissOverlays(page);
    } else if (step.do === "scroll") {
      await page.evaluate(([px, smooth]) => window.scrollBy({ top: px, behavior: smooth ? "smooth" : "auto" }), [step.px, !!step.smooth]);
      await sleep(900);
    } else if (step.do === "shot") {
      const buf = await page.screenshot({ fullPage: !!step.fullPage, animations: "disabled" });
      files.push({ url: await upload(`${step.name}-${files.length + 1}.png`, buf, "image/png"), kind: "imagen", name: step.name });
    }
  }
  // La sesión se renueva sola al navegar: se guarda la nueva.
  await account(data.job.app, { status: "conectada", state: await ctx.storageState() });
  const vid = video ? page.video() : null;
  await ctx.close();
  if (vid) {
    const webm = await vid.path();
    const mp4 = webm.replace(/\.webm$/, ".mp4");
    const r = spawnSync("ffmpeg", ["-y", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", mp4], { stdio: "ignore" });
    const [path, type, name] = r.status === 0 ? [mp4, "video/mp4", "video.mp4"] : [webm, "video/webm", "video.webm"];
    files.push({ url: await upload(name, readFileSync(path), type), kind: "video", name: "video" });
  }
  await report({ status: "lista", files });
}

const data = await api("GET", `?op=job&id=${JOB}`);
await report({ status: "corriendo", runUrl: RUN_URL });
const browser = await chromium.launch();
try {
  if (data.job.kind === "login") await login(browser, data);
  else await capture(browser, data);
  console.log("Listo:", JOB);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error("Falló:", message);
  if (data.job.kind === "login") await account(data.job.app, { status: "error", error: message.slice(0, 200) }).catch(() => null);
  await report({ status: "error", error: message.slice(0, 300) }).catch(() => null);
  process.exitCode = 1;
} finally {
  await browser.close();
}
