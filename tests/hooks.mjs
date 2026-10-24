// Resolve the "@shared/*" alias and extensionless relative imports so tests run the TypeScript sources directly.
import { existsSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"

const shared = new URL("../src/shared/", import.meta.url)

export async function resolve(specifier, context, next) {
  if (specifier === "electron") return next(new URL("./electron-stub.mjs", import.meta.url).href, context)
  if (specifier.startsWith("@shared/")) return next(new URL(`${specifier.slice(8)}.ts`, shared).href, context)
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[cm]?[jt]s$/.test(specifier) && context.parentURL?.startsWith("file:")) {
    const url = new URL(`${specifier}.ts`, context.parentURL)
    if (existsSync(fileURLToPath(url))) return next(pathToFileURL(fileURLToPath(url)).href, context)
  }
  return next(specifier, context)
}
