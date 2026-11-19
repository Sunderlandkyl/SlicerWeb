/* Extensions asked for by name: the wheels that install them.
 *
 * An extension index (extensions/index.json) names each extension's wheel, the extensions it
 * depends on and the SlicerWeb wheels it requires besides the startup ones (slicerweb-itk-extra,
 * say). `?extensions=SlicerHeart,SlicerIGT` on the address, or `extensions` in the runtime's
 * configuration, asks for extensions by those names, and they are installed at startup - with
 * what they depend on, in the order that needs - unless they already are.
 *
 * An index offers extensions somebody reviewed. Next to it there can be a second one,
 * unreviewed.json, of extensions nobody did: an extension runs with everything the page can
 * reach, so those are offered only to a user who asked to see them (in the Extensions Manager),
 * and a link cannot install one for a user who did not.
 */
export interface ExtensionIndexEntry {
  name: string;
  wheel: string;
  depends?: string[];
  requires?: string[];
  /** The hash of the wheel: it is checked before it is installed (wheelInstall.ts). */
  sha256?: string;
  /** Of the Slicer ExtensionsIndex (1 to 5); 0: not reviewed. */
  tier?: number;
  /** From unreviewed.json: nobody reviewed it. */
  unreviewed?: boolean;
}

export interface ExtensionIndex {
  extensions: ExtensionIndexEntry[];
}

export const EXTENSIONS_KEY = "slicerweb.extensions";
export const EXTENSION_INDEX_KEY = "slicerweb.extensionIndex";
export const UNREVIEWED_KEY = "slicerweb.unreviewedExtensions";

/** Whether the user asked to be offered the extensions nobody reviewed. */
export function unreviewedExtensionsShown(): boolean {
  try {
    return localStorage.getItem(UNREVIEWED_KEY) === "true";
  } catch {
    return false;
  }
}

export function showUnreviewedExtensions(shown: boolean) {
  try {
    if (shown) localStorage.setItem(UNREVIEWED_KEY, "true");
    else localStorage.removeItem(UNREVIEWED_KEY);
  } catch {
    // a private window, say
  }
}

/** Whether a name asked for is the address of a wheel rather than the name of an extension. */
export function isWheelAddress(name: string): boolean {
  return /^(https?:)?\/\//.test(name) || /\.whl$/.test(name);
}

/** The extension index the Extensions Manager uses: one chosen there, else the application's own. */
export function extensionIndexUrl(): string {
  try {
    return localStorage.getItem(EXTENSION_INDEX_KEY) ?? new URL("extensions/index.json", document.baseURI).href;
  } catch {
    return new URL("extensions/index.json", document.baseURI).href;
  }
}

/**
 * The extensions of an index, and with `unreviewed` those of the unreviewed.json next to it,
 * marked as such (a site need not have one).
 */
export async function loadExtensionIndex(url = extensionIndexUrl(), unreviewed = unreviewedExtensionsShown()): Promise<ExtensionIndex> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  const extensions: ExtensionIndexEntry[] = (await response.json()).extensions ?? [];
  if (unreviewed) {
    try {
      const other = await fetch(new URL("unreviewed.json", url).href);
      const entries: ExtensionIndexEntry[] = other.ok ? (await other.json()).extensions ?? [] : [];
      for (const entry of entries) {
        if (!extensions.some((e) => e.name.toLowerCase() === entry.name.toLowerCase())) extensions.push({ ...entry, unreviewed: true });
      }
    } catch (e) {
      console.warn(`The unreviewed extensions of ${url} are not available`, e);
    }
  }
  return { extensions };
}

/** The hash of each wheel of an index that gives one, by the address of the wheel. */
export function wheelHashes(index: ExtensionIndex, indexUrl: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  for (const entry of index.extensions) {
    if (entry.sha256) hashes[new URL(entry.wheel, indexUrl).href] = entry.sha256;
  }
  return hashes;
}

/**
 * The wheels that install these extensions (names from the index, or wheel URLs as they are), in
 * installation order: what an extension requires and depends on comes before it, and nothing
 * twice. A name the index does not know is reported, not installed.
 */
export async function resolveExtensionWheels(
  wanted: string[],
  index: ExtensionIndex,
  indexUrl: string,
  baseWheelUrl: (name: string) => Promise<string | null>,
): Promise<{ wheels: string[]; unknown: string[] }> {
  const wheels: string[] = [];
  const unknown: string[] = [];
  const add = (url: string) => {
    if (!wheels.includes(url)) wheels.push(url);
  };
  const visiting = new Set<string>();
  const visit = async (name: string) => {
    if (isWheelAddress(name)) {
      add(new URL(name, document.baseURI).href);
      return;
    }
    const entry = index.extensions.find((e) => e.name.toLowerCase() === name.toLowerCase());
    if (!entry) {
      if (!unknown.includes(name)) unknown.push(name);
      return;
    }
    if (visiting.has(entry.name)) return; // a cycle in the index: what is in it is already on its way
    visiting.add(entry.name);
    for (const base of entry.requires ?? []) {
      const url = await baseWheelUrl(base);
      if (url) add(url);
      else if (!unknown.includes(base)) unknown.push(base);
    }
    for (const dependency of entry.depends ?? []) await visit(dependency);
    add(new URL(entry.wheel, indexUrl).href);
  };
  for (const name of wanted) await visit(name.trim());
  return { wheels, unknown };
}

/** The extensions asked for on the address: `?extensions=SlicerHeart,SlicerIGT`. */
export function extensionsFromAddress(search = location.search): string[] {
  const params = new URLSearchParams(search);
  return (params.get("extensions") ?? "").split(/[,;\s]+/).map((n) => n.trim()).filter(Boolean);
}
