import dns from "node:dns";
import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import { applyAction, parseAction, StateActionError } from "./domain/actions.js";
import { importAnnualWorkbook, importHistoricalReports, previewAnnualWorkbook, previewHistoricalReports, type HistoricalFile } from "./domain/imports.js";
import { analytics, demonstrationState, validateVesselState } from "./domain/state.js";
import { VesselBackupModel } from "./models/VesselBackup.js";
import { VesselStateModel } from "./models/VesselState.js";

dotenv.config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

const app = express();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";
const vesselKey = process.env.VESSEL_KEY ?? "dht-leopard";
const annualUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15_000_000, files: 1 } });
const historicalUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5_000_000, files: 50 } });

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_request, response) => {
  response.status(mongoose.connection.readyState === 1 ? 200 : 503).json({
    status: mongoose.connection.readyState === 1 ? "ok" : "database-unavailable"
  });
});

app.get("/api/state", async (_request, response, next) => {
  try {
    const record = await VesselStateModel.findOne({ vesselKey }).lean();
    if (!record) {
      response.status(404).json({ error: `No migrated dataset found for vessel key "${vesselKey}".` });
      return;
    }
    const data = validateVesselState(record.data);
    response.setHeader("Cache-Control", "no-store");
    response.json({ data, analytics: analytics(data) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/demo", (_request, response) => {
  const data = demonstrationState();
  response.setHeader("Cache-Control", "no-store");
  response.json({ data, analytics: analytics(data) });
});

app.post("/api/action", async (request, response, next) => {
  try {
    const action = parseAction(request.body);
    const current = await VesselStateModel.findOne({ vesselKey }).lean();
    if (!current) {
      response.status(404).json({ error: `No migrated dataset found for vessel key "${vesselKey}".` });
      return;
    }
    const data = validateVesselState(current.data);
    if (action.revision !== data.revision) {
      response.status(409).json({ error: "Another user changed the data. Refresh before editing." });
      return;
    }
    const updated = applyAction(data, action);
    await VesselBackupModel.create({
      vesselKey,
      revision: data.revision,
      data
    });
    const saved = await VesselStateModel.findOneAndUpdate(
      { vesselKey, revision: current.revision },
      { $set: { data: updated, revision: updated.revision } },
      { new: true, runValidators: true }
    ).lean();
    if (!saved) {
      response.status(409).json({ error: "Another user changed the data. Refresh before editing." });
      return;
    }
    response.setHeader("Cache-Control", "no-store");
    response.json({ data: updated, analytics: analytics(updated) });
  } catch (error) {
    if (error instanceof Error && error.name === "ZodError") {
      response.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof StateActionError) {
      response.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.post("/api/workbook-preview", annualUpload.single("workbook"), async (request, response, next) => {
  try {
    const file = request.file;
    if (!file) throw new StateActionError("Choose an annual .xlsx workbook first.");
    const current = await VesselStateModel.findOne({ vesselKey }).lean();
    if (!current) throw new StateActionError(`No migrated dataset found for vessel key "${vesselKey}".`);
    const data = validateVesselState(current.data);
    const revision = Number(request.body.revision);
    if (revision !== data.revision) {
      response.status(409).json({ error: "The dashboard changed while you selected the workbook. Refresh and preview again." });
      return;
    }
    let preview;
    try {
      preview = await previewAnnualWorkbook(data, { name: file.originalname, buffer: file.buffer });
    } catch (error) {
      if (error instanceof Error) {
        response.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
    response.setHeader("Cache-Control", "no-store");
    response.json({ preview: preview.summary, fingerprint: preview.fingerprint, revision });
  } catch (error) {
    if (error instanceof StateActionError) {
      response.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.post("/api/workbook-import", annualUpload.single("workbook"), async (request, response, next) => {
  try {
    const file = request.file;
    if (!file) throw new StateActionError("Choose an annual .xlsx workbook first.");
    const current = await VesselStateModel.findOne({ vesselKey }).lean();
    if (!current) throw new StateActionError(`No migrated dataset found for vessel key "${vesselKey}".`);
    const data = validateVesselState(current.data);
    const revision = Number(request.body.revision);
    if (revision !== data.revision) {
      response.status(409).json({ error: "The dashboard changed while you selected the workbook. Refresh and preview again." });
      return;
    }
    let imported;
    try {
      imported = await importAnnualWorkbook(data, { name: file.originalname, buffer: file.buffer }, String(request.body.fingerprint ?? ""));
    } catch (error) {
      if (error instanceof Error) {
        response.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
    if (imported.data.revision !== data.revision) {
      await VesselBackupModel.create({ vesselKey, revision: data.revision, data });
      const saved = await VesselStateModel.findOneAndUpdate(
        { vesselKey, revision: current.revision },
        { $set: { data: imported.data, revision: imported.data.revision } },
        { new: true, runValidators: true }
      ).lean();
      if (!saved) {
        response.status(409).json({ error: "Another user changed the data. Refresh before importing." });
        return;
      }
    }
    response.setHeader("Cache-Control", "no-store");
    response.json({ data: imported.data, analytics: analytics(imported.data), import_summary: imported.summary });
  } catch (error) {
    if (error instanceof StateActionError) {
      response.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.post("/api/history-preview", historicalUpload.array("files", 50), async (request, response, next) => {
  try {
    const files = (request.files ?? []) as Express.Multer.File[];
    const paths = JSON.parse(String(request.body.paths ?? "[]")) as unknown;
    if (!Array.isArray(paths) || paths.length !== files.length || !paths.every((path) => typeof path === "string")) {
      throw new StateActionError("Historical report upload paths are incomplete; select the folder again.");
    }
    const current = await VesselStateModel.findOne({ vesselKey }).lean();
    if (!current) throw new StateActionError(`No migrated dataset found for vessel key "${vesselKey}".`);
    const data = validateVesselState(current.data);
    const revision = Number(request.body.revision);
    if (revision !== data.revision) {
      response.status(409).json({ error: "The dashboard changed while scanning. Refresh and scan again." });
      return;
    }
    const historicalFiles: HistoricalFile[] = files.map((file, index) => ({
      name: file.originalname,
      relativePath: paths[index] as string,
      buffer: file.buffer
    }));
    let preview;
    try {
      preview = await previewHistoricalReports(data, historicalFiles);
    } catch (error) {
      if (error instanceof Error) {
        response.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
    response.setHeader("Cache-Control", "no-store");
    response.json({ preview: preview.summary, fingerprint: preview.summary.fingerprint, revision });
  } catch (error) {
    if (error instanceof StateActionError || error instanceof SyntaxError) {
      response.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.post("/api/history-import", historicalUpload.array("files", 50), async (request, response, next) => {
  try {
    const files = (request.files ?? []) as Express.Multer.File[];
    const paths = JSON.parse(String(request.body.paths ?? "[]")) as unknown;
    if (!Array.isArray(paths) || paths.length !== files.length || !paths.every((path) => typeof path === "string")) {
      throw new StateActionError("Historical report upload paths are incomplete; select the folder again.");
    }
    const current = await VesselStateModel.findOne({ vesselKey }).lean();
    if (!current) throw new StateActionError(`No migrated dataset found for vessel key "${vesselKey}".`);
    const data = validateVesselState(current.data);
    const revision = Number(request.body.revision);
    if (revision !== data.revision) {
      response.status(409).json({ error: "The dashboard changed while importing. Refresh and scan again." });
      return;
    }
    const historicalFiles: HistoricalFile[] = files.map((file, index) => ({
      name: file.originalname,
      relativePath: paths[index] as string,
      buffer: file.buffer
    }));
    let imported;
    try {
      imported = await importHistoricalReports(data, historicalFiles, String(request.body.fingerprint ?? ""));
    } catch (error) {
      if (error instanceof Error) {
        response.status(400).json({ error: error.message });
        return;
      }
      throw error;
    }
    if (imported.data.revision !== data.revision) {
      await VesselBackupModel.create({ vesselKey, revision: data.revision, data });
      const saved = await VesselStateModel.findOneAndUpdate(
        { vesselKey, revision: current.revision },
        { $set: { data: imported.data, revision: imported.data.revision } },
        { new: true, runValidators: true }
      ).lean();
      if (!saved) {
        response.status(409).json({ error: "Another user changed the data. Refresh before importing." });
        return;
      }
    }
    response.setHeader("Cache-Control", "no-store");
    response.json({ data: imported.data, analytics: analytics(imported.data), import_summary: imported.import_summary });
  } catch (error) {
    if (error instanceof StateActionError || error instanceof SyntaxError) {
      response.status(400).json({ error: error.message });
      return;
    }
    next(error);
  }
});

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof multer.MulterError) {
    response.status(400).json({ error: error.message });
    return;
  }
  console.error(error);
  response.status(500).json({ error: "The API could not complete the request." });
});

async function start() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI must be configured before starting the API.");
  const dnsServers = process.env.DNS_SERVERS?.split(",").map((server) => server.trim()).filter(Boolean);
  if (dnsServers?.length) dns.setServers(dnsServers);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10_000 });
  app.listen(port, host, () => {
    console.log(`Running Hour Sheet API listening at http://127.0.0.1:${port}`);
  });
}

start().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
