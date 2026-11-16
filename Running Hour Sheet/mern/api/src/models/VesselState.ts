import { Schema, model } from "mongoose";

const vesselStateSchema = new Schema({
  vesselKey: { type: String, required: true, unique: true, immutable: true },
  revision: { type: Number, required: true, min: 0 },
  sourceSha256: { type: String, required: true, immutable: true },
  migratedAt: { type: Date, required: true, immutable: true },
  data: { type: Schema.Types.Mixed, required: true }
}, {
  collection: "vessel_states",
  versionKey: false,
  timestamps: true
});

export const VesselStateModel = model("VesselState", vesselStateSchema);
