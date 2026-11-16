import { createHash } from "node:crypto";
import dns from "node:dns";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import dotenv from "dotenv";
import mongoose from "mongoose";
import { VesselStateModel } from "../models/VesselState.js";
import { summarizeVesselState, validateVesselState } from "../domain/state.js";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
}

async function main() {
  const projectRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const sourcePath = resolve(projectRoot, option("--source", "../dashboard_data.json"));
  const apply = process.argv.includes("--apply");
  const raw = await readFile(sourcePath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    throw new Error(`Source is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const data = validateVesselState(parsed);
  const sourceSha256 = createHash("sha256").update(raw).digest("hex");
  const vesselKey = option("--vessel-key", process.env.VESSEL_KEY ?? "dht-leopard");
  const summary = summarizeVesselState(data);
  console.log(JSON.stringify({
    mode: apply ? "apply" : "dry-run",
    sourceFile: basename(sourcePath),
    sourceSha256,
    vesselKey,
    summary
  }, null, 2));

  if (!apply) {
    console.log("Dry run only. No database connection or file changes were made. Add --apply only after target approval.");
    return;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required when --apply is specified.");
  const dnsServers = process.env.DNS_SERVERS?.split(",").map((server) => server.trim()).filter(Boolean);
  if (dnsServers?.length) dns.setServers(dnsServers);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  try {
    const existing = await VesselStateModel.findOne({ vesselKey }).select("sourceSha256").lean();
    if (existing) {
      if (existing.sourceSha256 === sourceSha256) {
        console.log("This exact source file was already migrated; no database changes were made.");
        return;
      }
      throw new Error(`Vessel key "${vesselKey}" already has a different migrated dataset. Refusing to overwrite.`);
    }

    await VesselStateModel.create({
      vesselKey,
      revision: data.revision,
      sourceSha256,
      migratedAt: new Date(),
      data
    });
    console.log("Migration inserted. Source JSON remains unchanged.");
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
