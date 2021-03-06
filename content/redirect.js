const fs = require("fs");
const path = require("path");

const { resolveFundamental } = require("../libs/fundamental-redirects");
const { decodePath, slugToFolder } = require("../libs/slug-utils");
const {
  CONTENT_ROOT,
  CONTENT_TRANSLATED_ROOT,
  VALID_LOCALES,
} = require("./constants");
const { isArchivedFilePath } = require("./archive");

const FORBIDDEN_URL_SYMBOLS = ["\n", "\t"];
const VALID_LOCALES_SET = new Set([...VALID_LOCALES.values()]);

function checkURLInvalidSymbols(url) {
  for (const character of FORBIDDEN_URL_SYMBOLS) {
    if (url.includes(character)) {
      throw new Error(`URL contains invalid character '${character}'`);
    }
  }
}

function isVanityRedirectURL(url) {
  const localeUrls = new Set([...VALID_LOCALES.values()].map((l) => `/${l}/`));
  return localeUrls.has(url);
}

function resolveDocumentPath(url) {
  // Let's keep vanity urls to /en-US/ ...
  if (isVanityRedirectURL(url)) {
    return url;
  }
  const [bareURL] = url.split("#");

  const [, locale, , ...slug] = bareURL.toLowerCase().split("/");

  const relativeFilePath = path.join(
    locale,
    slugToFolder(slug.join("/")),
    "index.html"
  );

  if (isArchivedFilePath(relativeFilePath)) {
    return `$ARCHIVED/${relativeFilePath}`;
  }

  const root = locale === "en-us" ? CONTENT_ROOT : CONTENT_TRANSLATED_ROOT;

  if (!root) {
    console.log(
      `Trying to resolve a non-en-us path for ${url} without CONTENT_TRANSLATED_ROOT set.`
    );
    return `$TRANSLATED/${relativeFilePath}`;
  }
  const filePath = path.join(root, relativeFilePath);
  if (fs.existsSync(filePath)) {
    return filePath;
  }
  return null;
}

// Throw if this can't be a redirect from-URL.
function validateFromURL(url, checkResolve = true) {
  if (!url.startsWith("/")) {
    throw new Error(`From-URL must start with a / was ${url}`);
  }
  if (!url.includes("/docs/")) {
    throw new Error(`From-URL must contain '/docs/' was ${url}`);
  }
  if (!VALID_LOCALES_SET.has(url.split("/")[1])) {
    throw new Error(`The locale prefix is not valid or wrong case was ${url}`);
  }
  checkURLInvalidSymbols(url);
  // This is a circular dependency we should solve that in another way.
  validateURLLocale(url);
  const path = resolveDocumentPath(url);
  if (path) {
    throw new Error(`From-URL resolves to a file (${path})`);
  }
  if (checkResolve) {
    const resolved = resolve(url);
    if (resolved !== url) {
      throw new Error(
        `${url} is already matched as a redirect (to: '${resolved}')`
      );
    }
  }
}

// Throw if this can't be a redirect to-URL.
function validateToURL(url, checkResolve = true, checkPath = true) {
  // Let's keep vanity urls to /en-US/ ...
  if (isVanityRedirectURL(url)) {
    return url;
  }
  // If it's not external, it has to go to a valid document
  if (url.includes("://")) {
    // If this throws, conveniently the validator will do its job.
    const parsedURL = new URL(url);
    if (parsedURL.protocol !== "https:") {
      throw new Error("We only redirect to https://");
    }
  } else if (url.startsWith("/")) {
    checkURLInvalidSymbols(url);
    validateURLLocale(url);

    if (checkResolve) {
      // Can't point to something that redirects to something
      const resolved = resolve(url);
      if (resolved !== url) {
        throw new Error(
          `${url} is already matched as a redirect (to: '${resolved}')`
        );
      }
    }
    if (checkPath) {
      const path = resolveDocumentPath(url);
      if (!path) {
        throw new Error(`To-URL has to resolve to a file (${url})`);
      }
    }
  } else {
    throw new Error(`To-URL has to be external or start with / (${url})`);
  }
}

function validateURLLocale(url) {
  // Check that it's a valid document URL
  const [nothing, locale, docs] = url.split("/");
  if (nothing || !locale || docs !== "docs") {
    throw new Error(`The URL is expected to start with /$locale/docs/: ${url}`);
  }
  const validValues = [...VALID_LOCALES.values()];
  if (!validValues.includes(locale)) {
    throw new Error(`'${locale}' not in ${validValues}`);
  }
}

function errorOnEncoded(paris) {
  for (const [from, to] of paris) {
    const [decodedFrom, decodedTo] = decodePair([from, to]);
    if (decodedFrom !== from) {
      throw new Error(`From URL must be decoded: ${from}`);
    }
    if (decodedTo !== to) {
      throw new Error(`To URL must be decoded: ${to}`);
    }
  }
}

function errorOnDuplicated(pairs) {
  const seen = new Set();
  for (const [from] of pairs) {
    const fromLower = from.toLowerCase();
    if (seen.has(fromLower)) {
      throw new Error(`Duplicated redirect: ${fromLower}`);
    }
    seen.add(fromLower);
  }
}

function removeConflictingOldRedirects(oldPairs, updatePairs) {
  if (oldPairs.length === 0) {
    return oldPairs;
  }
  const newTargets = new Set(updatePairs.map(([, to]) => to.toLowerCase()));

  return oldPairs.filter(([from, to]) => {
    const conflictingTo = newTargets.has(from.toLowerCase());
    if (conflictingTo) {
      console.log(`removing conflicting redirect ${from}\t${to}`);
    }
    return !conflictingTo;
  });
}

function removeOrphanedRedirects(pairs) {
  return pairs.filter(([from, to]) => {
    if (resolveDocumentPath(from)) {
      console.log(`removing orphaned redirect (from exists): ${from}\t${to}`);
      return false;
    }
    if (to.startsWith("/") && !resolveDocumentPath(to)) {
      console.log(
        `removing orphaned redirect (to doesn't exists): ${from}\t${to}`
      );
      return false;
    }
    return true;
  });
}

function loadPairsFromFile(filePath, strict = true) {
  const content = fs.readFileSync(filePath, "utf-8");
  const pairs = content
    .trim()
    .split("\n")
    // Skip the header line.
    .slice(1)
    .map((line) => line.trim().split(/\t+/));

  if (strict) {
    errorOnEncoded(pairs);
    errorOnDuplicated(pairs);
  }
  validatePairs(pairs, strict);
  return pairs;
}

function loadLocaleAndAdd(locale, updatePairs, { fix = false } = {}) {
  errorOnEncoded(updatePairs);
  errorOnDuplicated(updatePairs);
  validatePairs(updatePairs);

  locale = locale.toLowerCase();
  let root = CONTENT_ROOT;
  if (locale !== "en-us") {
    if (CONTENT_TRANSLATED_ROOT) {
      root = CONTENT_TRANSLATED_ROOT;
    } else {
      throw new Error(
        `trying to add redirects for ${locale} but CONTENT_TRANSLATED_ROOT not set`
      );
    }
  }
  const redirectsFilePath = path.join(root, locale, "_redirects.txt");
  const pairs = [];
  if (fs.existsSync(redirectsFilePath)) {
    // If we wanna fix we load relaxed, hence the !fix.
    pairs.push(...loadPairsFromFile(redirectsFilePath, !fix));
  }

  const cleanPairs = removeConflictingOldRedirects(pairs, updatePairs);
  cleanPairs.push(...updatePairs);

  let simplifiedPairs = shortCuts(cleanPairs);
  if (fix) {
    simplifiedPairs = removeOrphanedRedirects(simplifiedPairs);
  }
  validatePairs(simplifiedPairs);

  return { pairs: simplifiedPairs, root, changed: simplifiedPairs == pairs };
}

function add(locale, updatePairs, { fix = false } = {}) {
  const { pairs, root } = loadLocaleAndAdd(locale, updatePairs, { fix });
  save(path.join(root, locale), pairs);
}

function validateLocale(locale, strict = false) {
  // To validate strict we check if there is something to fix.
  const { changed } = loadLocaleAndAdd(locale, [], { fix: strict });
  if (changed) {
    throw new Error(` _redirects.txt for ${locale} is flawed`);
  }
}

function redirectFilePathForLocale(locale, throws = false) {
  const makeFilePath = (root) =>
    path.join(root, locale.toLowerCase(), "_redirects.txt");

  const filePath = makeFilePath(CONTENT_ROOT);
  if (fs.existsSync(filePath)) {
    return filePath;
  }
  if (CONTENT_TRANSLATED_ROOT) {
    const translatedFilePath = makeFilePath(CONTENT_TRANSLATED_ROOT);

    if (fs.existsSync(translatedFilePath)) {
      return translatedFilePath;
    }
  }
  if (throws) {
    throw new Error(`no _redirects file for ${locale}`);
  }
  return null;
}

// The module level cache
const redirects = new Map();

function load(locales = [...VALID_LOCALES.keys()], verbose = false) {
  const files = locales
    .map((locale) => redirectFilePathForLocale(locale))
    .filter((f) => f !== null);

  for (const redirectsFilePath of files) {
    if (verbose) {
      console.log(`Checking ${redirectsFilePath}`);
    }
    const pairs = loadPairsFromFile(redirectsFilePath, false);
    // Now that all have been collected, transfer them to the `redirects` map
    // but also do invariance checking.
    for (const [from, to] of pairs) {
      redirects.set(from.toLowerCase(), to);
    }
  }
}

const resolve = (url) => {
  if (!redirects.size) {
    load();
  }
  const fundamentalOrUrl = resolveFundamental(url).url || url;
  return (
    redirects.get(decodePath(fundamentalOrUrl).toLowerCase()) ||
    fundamentalOrUrl
  );
};

function shortCuts(pairs, throws = false) {
  // We have mixed cases in the _redirects.txt like:
  // /en-US/docs/window.document     /en-US/docs/Web/API/window.document
  // /en-US/docs/Web/API/Window.document     /en-US/docs/Web/API/Window/document
  // therefore we have to lowercase everything and restore it later.
  const casing = new Map([
    ...pairs.map(([from]) => [from.toLowerCase(), from]),
    ...pairs.map(([, to]) => [to.toLowerCase(), to]),
  ]);
  const lowerCasePairs = pairs.map(([from, to]) => [
    from.toLowerCase(),
    to.toLowerCase(),
  ]);

  // Directed graph of all redirects.
  const dg = new Map(lowerCasePairs);

  // Transitive directed acyclic graph of all redirects.
  // All redirects are expanded A -> B, B -> C becomes:
  // A -> B, B -> C, A -> C and all cycles are removed.
  const transitiveDag = new Map();

  // Expand all "edges" and keep track of the nodes we traverse.
  const transit = (s, froms = []) => {
    const next = dg.get(s);
    if (next) {
      froms.push(s);
      if (froms.includes(next)) {
        const msg = `redirect cycle [${froms.join(", ")}] → ${next}`;
        if (throws) {
          throw new Error(msg);
        }
        console.log(msg);
        return [];
      }
      return transit(next, froms);
    }
    return [froms, s];
  };

  const sortTuples = ([a, b], [c, d]) => {
    if (a > c) {
      return 1;
    }
    if (a < c) {
      return -1;
    }
    if (b > d) {
      return 1;
    }
    if (b < d) {
      return -1;
    }
    return 0;
  };

  for (const [from] of lowerCasePairs) {
    const [froms = [], to] = transit(from);
    for (const from of froms) {
      transitiveDag.set(from, to);
    }
  }
  const transitivePairs = [...transitiveDag.entries()];

  // Restore cases!
  const mappedPairs = transitivePairs.map(([from, to]) => [
    casing.get(from),
    casing.get(to),
  ]);
  mappedPairs.sort(sortTuples);
  return mappedPairs;
}

function decodePair([from, to]) {
  const fromDecoded = decodePath(from);
  let toDecoded;
  if (to.startsWith("/")) {
    toDecoded = decodePath(to);
  } else {
    toDecoded = decodeURI(to);
  }
  return [fromDecoded, toDecoded];
}

function decodePairs(pairs) {
  return pairs.map((pair) => decodePair(pair));
}

function validatePairs(pairs, checkExists = true) {
  for (const [from, to] of pairs) {
    validateFromURL(from, false);
    validateToURL(to, false, checkExists);
  }
}

function save(localeFolder, pairs) {
  const filePath = path.join(localeFolder, "_redirects.txt");
  const writeStream = fs.createWriteStream(filePath);
  writeStream.write(`# FROM-URL\tTO-URL\n`);
  for (const [fromURL, toURL] of pairs) {
    writeStream.write(`${fromURL}\t${toURL}\n`);
  }
  writeStream.end();
}

module.exports = {
  add,
  resolve,
  load,
  validateFromURL,
  validateToURL,
  validateLocale,

  testing: {
    shortCuts,
    decodePairs,
  },
};
