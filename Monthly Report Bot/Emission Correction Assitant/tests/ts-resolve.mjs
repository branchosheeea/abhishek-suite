// Test-only module hook (same as the NeraVeda web shell): lets Node's built-in test runner load the app's
// TypeScript modules, which import each other without file extensions. Node 24 strips the types itself.
import { registerHooks } from "node:module"

const RELATIVE = /^\.{1,2}\//
const HAS_EXTENSION = /\.[cm]?[jt]sx?$/

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (RELATIVE.test(specifier) && !HAS_EXTENSION.test(specifier)) {
      for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
        try {
          return nextResolve(candidate, context)
        } catch {
          // try the next candidate
        }
      }
    }
    return nextResolve(specifier, context)
  },
})
