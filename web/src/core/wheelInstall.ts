/* Installing a wheel whose content is checked first.
 *
 * An extension index gives the hash (sha256) of each wheel it names. A wheel that has one is
 * fetched here, compared with it, and only then handed to micropip, from the file system: what is
 * installed is what the index describes, wherever the wheel is kept - on the site, or on another
 * one that the index points to - and whatever stands between it and the page. A wheel without a
 * hash (one installed from an address the user gave) is fetched by micropip, as it always was.
 *
 * Used by the page (runtime.ts) and by the worker that runs jobs (jobWorker.ts), which installs
 * the same wheels in a Python of its own.
 */

/** The hash of each installed wheel, by its address: what a start without the index checks against. */
export const WHEEL_HASHES_KEY = "slicerweb.extensionHashes";

export function storedWheelHashes(): Record<string, string> {
  try {
    const stored = JSON.parse(localStorage.getItem(WHEEL_HASHES_KEY) ?? "{}");
    return stored && typeof stored === "object" ? stored : {};
  } catch {
    return {};
  }
}

export function storeWheelHashes(hashes: Record<string, string>) {
  try {
    localStorage.setItem(WHEEL_HASHES_KEY, JSON.stringify(hashes));
  } catch {
    // a private window, say: known for this page
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Install the wheel at `url` with micropip (`options` are micropip.install's). With `sha256`, the
 * wheel is refused unless its content has that hash.
 */
export async function installWheelChecked(
  pyodide: any,
  micropip: any,
  url: string,
  sha256: string | undefined,
  options: Record<string, unknown>,
): Promise<void> {
  if (!sha256) {
    await micropip.install(url, options);
    return;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actual = await sha256Hex(bytes);
  if (actual !== sha256.toLowerCase()) {
    throw new Error(`${url} is not the file its extension index describes (sha256 ${actual.slice(0, 12)}…, ` +
      `expected ${sha256.slice(0, 12)}…): not installed`);
  }
  // micropip reads the name, the version and the platform of a wheel from its file name
  const name = decodeURIComponent(new URL(url, "file:///").pathname.split("/").pop() ?? "");
  if (!/^[A-Za-z0-9_.+-]+\.whl$/.test(name)) throw new Error(`${url} does not end with the file name of a wheel`);
  const folder = "/tmp/slicerweb-wheels";
  pyodide.FS.mkdirTree(folder);
  const path = `${folder}/${name}`;
  pyodide.FS.writeFile(path, bytes);
  try {
    await micropip.install(`emfs:${path}`, options);
  } finally {
    try {
      pyodide.FS.unlink(path);
    } catch {
      // already gone
    }
  }
}
