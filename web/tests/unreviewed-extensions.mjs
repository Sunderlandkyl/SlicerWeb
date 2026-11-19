// The hash check of extension wheels, the unreviewed extensions and the wheels asked for on the
// address of the page.
//
// It needs an extension index that gives hashes, one of them wrong, and an unreviewed.json next to
// it: tests/unreviewed-extensions-index.py makes those of a folder of extension wheels (the one
// SLICERWEB_EXTENSIONS names for the development server), and prints the roles this reads.
// Usage: python tests/unreviewed-extensions-index.py <extensions folder> > roles.json
//        node tests/unreviewed-extensions.mjs <base url> roles.json
import { chromium } from "playwright-core";
import fs from "node:fs";

const [base, rolesFile] = process.argv.slice(2);
const roles = JSON.parse(fs.readFileSync(rolesFile, "utf8"));
console.log("roles:", JSON.stringify(roles));
let failed = 0;
const check = (what, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failed++;
};

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined, headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });

async function open(context, address, answers) {
  const page = await context.newPage();
  page.logs = [];
  page.dialogs = [];
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") page.logs.push(m.text());
  });
  page.on("pageerror", (e) => page.logs.push(`pageerror ${e}`));
  page.on("dialog", async (dialog) => {
    page.dialogs.push(dialog.message());
    const accept = answers.shift() ?? false;
    if (accept) await dialog.accept();
    else await dialog.dismiss();
  });
  await page.goto(address);
  await page.waitForFunction(() => window.slicerWeb?.bridge && document.querySelector("canvas"), null, { timeout: 600000 });
  return page;
}
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("slicerweb.extensions") ?? "[]"));
const hashes = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("slicerweb.extensionHashes") ?? "{}"));
async function manager(page) {
  await page.getByLabel("Application menu").click();
  await page.locator("[role=menuitem]", { hasText: /extensions manager/i }).first().click();
  await page.waitForSelector("[data-extension]", { timeout: 60000 });
}
const card = (page, name) => page.locator(`[data-extension="${name}"]`);
async function install(page, name) {
  await card(page, name).getByRole("button", { name: /^install$/i }).click();
  await page.waitForFunction((n) => new RegExp(`${n} installed|${n} failed|${n} was not installed`).test(document.body.innerText),
    name, { timeout: 600000 });
  return (await page.locator(".bg-accent").first().innerText()).slice(0, 300);
}
const importable = (page, name) => page.evaluate(async (n) => {
  const b = window.slicerWeb.bridge;
  await b.evalPython(`
import importlib.metadata as _m, json
_found = json.dumps(sorted(d.metadata["Name"] for d in _m.distributions() if "${n}".lower() in d.metadata["Name"].lower().replace("-", "").replace("_", "")))
`);
  return b.evalPython("_found", "eval");
}, name);

// ---- 1. the manager: reviewed extensions only, a wheel of the right hash, one of the wrong hash
let context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const answers = [];
let page = await open(context, `${base}?sample=`, answers);
await manager(page);
check("the unreviewed extension is not offered", (await card(page, roles.unreviewed).count()) === 0);
check("no extension is marked unreviewed", (await page.locator("[data-name=unreviewedExtension]").count()) === 0);
let status = await install(page, roles.good);
check(`a wheel of the hash the index gives is installed (${roles.good})`, /installed\./.test(status), status);
check("  and its distribution is there", (await importable(page, roles.good)) !== "[]", await importable(page, roles.good));
check("  and its hash is kept", Object.keys(await hashes(page)).some((u) => (new RegExp(roles.good, "i")).test(u.replace(/[-_]/g, ""))) || Object.keys(await hashes(page)).length === 1, JSON.stringify(await hashes(page)).slice(0, 160));
status = await install(page, roles.wrong);
check(`a wheel of another hash is refused (${roles.wrong})`, /failed: .*is not the file its extension index describes/.test(status), status);
check("  and not kept as installed", (await stored(page)).length === 1, JSON.stringify(await stored(page)));

// ---- 2. the unreviewed extensions: asked for, warned about, and marked
answers.push(false);
await page.locator("[data-name=showUnreviewedExtensions]").click();
await page.waitForTimeout(1000);
check("declining the warning leaves them out", (await card(page, roles.unreviewed).count()) === 0 && page.dialogs.length === 1, page.dialogs.at(-1)?.slice(0, 60));
answers.push(true);
await page.locator("[data-name=showUnreviewedExtensions]").click();
await card(page, roles.unreviewed).waitFor({ timeout: 30000 });
check("accepting it shows them, marked", (await card(page, roles.unreviewed).locator("[data-name=unreviewedExtension]").count()) === 1);
check("  and only them are marked", (await page.locator("[data-name=unreviewedExtension]").count()) === 1);
answers.push(false);
status = await install(page, roles.unreviewed);
check("installing one asks first, and No leaves it out", /was not installed/.test(status) && (await stored(page)).length === 1, status);
answers.push(true);
status = await install(page, roles.unreviewed);
check("  and Yes installs it", /installed\./.test(status) && (await stored(page)).length === 2, status);

// ---- 3. the next start installs both again, checked against the kept hashes
await page.close();
page = await open(context, `${base}?sample=`, []);
check("a new start has both", (await stored(page)).length === 2 && (await importable(page, roles.good)) !== "[]" && (await importable(page, roles.unreviewed)) !== "[]",
  page.logs.filter((l) => /extension|wheel/i.test(l)).join(" | ").slice(0, 300));
check("  without a dialog", page.dialogs.length === 0);
// The job worker installs the same wheels, checked too
const job = await page.evaluate(async () => {
  try {
    const { jobRunner } = await import("/src/core/jobs.ts");
    await jobRunner().start();
    return "started";
  } catch (e) {
    return `failed: ${e}`;
  }
});
check("the worker that runs jobs starts with them", job === "started", job);

// ---- 4. a wheel that changed since: refused at the start, and forgotten
await page.evaluate((good) => {
  const kept = JSON.parse(localStorage.getItem("slicerweb.extensionHashes"));
  const url = Object.keys(kept).find((u) => u.toLowerCase().replace(/[-_]/g, "").includes(good.toLowerCase()));
  kept[url] = "1".repeat(64);
  localStorage.setItem("slicerweb.extensionHashes", JSON.stringify(kept));
  // and no index to correct it from
  localStorage.setItem("slicerweb.extensionIndex", new URL("extensions/none.json", document.baseURI).href);
}, roles.good);
await page.close();
page = await open(context, `${base}?sample=`, []);
check("a wheel that is not what was installed is refused at the start", page.logs.some((l) => /could not be installed, and is removed/.test(l) && /not the file/.test(l)),
  page.logs.filter((l) => /removed|not the file/.test(l)).join(" | ").slice(0, 300));
const left = (await stored(page)).filter((u) => u.includes("/extensions/"));
check("  and the other one stays", left.length === 1 && left[0].endsWith(roles.unreviewedWheel) && (await importable(page, roles.unreviewed)) !== "[]", JSON.stringify(left));
const extra = (await stored(page)).filter((u) => !u.includes("/extensions/"));
if (extra.length) console.log(`note the application's own wheels are now among the installed extensions (${extra.length}): as before this change?`);
await context.close();

// ---- 5. the address of the page: an unreviewed name installs nothing, a wheel asks
context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
page = await open(context, `${base}?sample=&extensions=${encodeURIComponent(roles.unreviewed)}`, []);
check("a link naming an unreviewed extension installs nothing", (await stored(page)).length === 0 && page.dialogs.length === 0,
  page.logs.filter((l) => /not in/.test(l)).join(" | ").slice(0, 200));
await page.close();
const wheel = new URL(`extensions/${roles.unreviewedWheel}`, base).href;
page = await open(context, `${base}?sample=&extensions=${encodeURIComponent(wheel)}`, [false]);
check("a link giving the address of a wheel asks", page.dialogs.length === 1 && page.dialogs[0].includes(wheel), page.dialogs[0]?.slice(0, 80));
check("  and No installs nothing", (await stored(page)).length === 0, JSON.stringify(await stored(page)));
await page.close();
page = await open(context, `${base}?sample=&extensions=${encodeURIComponent(wheel)}`, [true]);
check("  and Yes installs it", (await stored(page)).length === 1 && (await importable(page, roles.unreviewed)) !== "[]", JSON.stringify(await stored(page)));
await page.close();
page = await open(context, `${base}?sample=&extensions=${encodeURIComponent(roles.good)}`, []);
check("a link naming a reviewed extension installs it, as before, and what was installed stays", (await stored(page)).length === 2 && page.dialogs.length === 0
  && (await importable(page, roles.good)) !== "[]" && (await importable(page, roles.unreviewed)) !== "[]", JSON.stringify(await stored(page)).slice(0, 300));

await browser.close();
console.log(failed ? `${failed} FAILED` : "ALL PASSED");
process.exit(failed ? 1 : 0);
