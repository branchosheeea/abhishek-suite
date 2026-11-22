// Digital Docking: the one store this web server uses, opened on first use. A backup is made the first time the store
// is used each day (in the background; a failure is logged, never shown as lost data). Server-side only.

import { existsSync, readdirSync } from "node:fs"
import { currentUser } from "../../server/auth"
import { backupDir, backupStore } from "./backup"
import { openStore, type Store } from "./db"
import { rememberPerson } from "./reports"

const state = globalThis as unknown as { __dockingStore?: Promise<Store>; __dockingBackupDay?: string }

function latestBackupDay(store: Store): string {
  const dir = backupDir(store)
  if (!existsSync(dir)) return ""
  const stamps = readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}T/.test(n)).sort()
  return stamps.length ? stamps[stamps.length - 1].slice(0, 10) : ""
}

function dailyBackup(store: Store) {
  const today = new Date().toISOString().slice(0, 10)
  if (state.__dockingBackupDay === today) return
  state.__dockingBackupDay = today
  if (latestBackupDay(store) === today) return
  backupStore(store).catch((error) => console.error("[docking] daily backup failed:", error))
}

export async function dockingStore(): Promise<Store> {
  state.__dockingStore ??= openStore().catch((error) => {
    state.__dockingStore = undefined // let the next request try again
    throw error
  })
  const store = await state.__dockingStore
  dailyBackup(store)
  const user = currentUser()
  if (user?.typ === "session") {
    try {
      rememberPerson(store, user.sub, user.name)
    } catch (error) {
      console.error("[docking] could not record the signed-in name:", error)
    }
  }
  return store
}
