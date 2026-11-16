import { Schema, model } from "mongoose";

const vesselBackupSchema = new Schema({
  vesselKey: { type: String, required: true, index: true },
  revision: { type: Number, required: true, min: 0 },
  createdAt: { type: Date, required: true, default: Date.now },
  data: { type: Schema.Types.Mixed, required: true }
}, {
  collection: "vessel_backups",
  versionKey: false
});

export const VesselBackupModel = model("VesselBackup", vesselBackupSchema);
