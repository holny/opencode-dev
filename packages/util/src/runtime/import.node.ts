import { Script, constants } from "node:vm"
import { createRequire, registerHooks } from "node:module"
import { statSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

export async function importModule(specifier: string) {
  const imported = (await new Script(`import(${JSON.stringify(specifier)})`, {
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  }).runInThisContext()) as unknown
  if (typeof imported !== "object" || imported === null) return imported

  const module = imported as Record<string, unknown>
  const exports = module["module.exports"]
  if (exports !== module.default || (typeof exports !== "object" && typeof exports !== "function") || exports === null)
    return imported
  return Object.assign({}, module, exports)
}

export function resolveModule(specifier: string, directory: string) {
  // Node only accepts import.meta.resolve's parent URL behind an experimental
  // flag. Scope this synchronous resolution to the caller's package directory
  // through the supported resolver hook instead.
  // SEA (mainFormat "module") evaluates the main ESM without exposing
  // import.meta.resolve at all; fall back to CJS resolution rooted at the
  // caller's package directory.
  const native = typeof import.meta.resolve === "function"
  const resolveOne = native
    ? (target: string) => import.meta.resolve(path.isAbsolute(target) ? pathToFileURL(target).href : target)
    : (target: string) => pathToFileURL(createRequire(path.join(directory, "package.json")).resolve(target)).href
  const hook = native
    ? registerHooks({
        resolve(specifier, context, nextResolve) {
          return nextResolve(specifier, { ...context, parentURL: pathToFileURL(path.join(directory, "package.json")).href })
        },
      })
    : undefined
  try {
    const resolve = (target: string) => {
      const resolved = resolveOne(target)
      if (resolved.startsWith("file:")) statSync(new URL(resolved))
      return resolved
    }
    try {
      return resolve(specifier)
    } catch (error) {
      if (path.extname(specifier) || !missing(error)) throw error
      // Node does not infer extensions for local files or legacy package
      // subpaths. Resolve each candidate natively so package exports still apply.
      for (const extension of [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"]) {
        try {
          return resolve(specifier + extension)
        } catch (cause) {
          if (!missing(cause)) throw cause
        }
      }
      throw error
    }
  } finally {
    hook?.deregister()
  }
}

function missing(error: unknown) {
  return (
    error instanceof Error &&
    "code" in error &&
    // MODULE_NOT_FOUND is the CJS resolver's code (the SEA fallback path).
    ["ENOENT", "ENOTDIR", "MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND"].includes(String(error.code))
  )
}
