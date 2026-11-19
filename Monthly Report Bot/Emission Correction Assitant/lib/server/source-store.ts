// Registered source artifacts: the original vessel files, byte for byte.
//
// THIS STORE IS INSERT-ONLY BY DESIGN. It has no update, replace, rename or delete operation, and none may be
// added: the test suite scans this file for MongoDB write verbs other than insert. Registration is the only
// write: bytes are hashed, uploaded to GridFS, read back and re-hashed, and only then is the artifact record
// (whose _id is the SHA-256) inserted. A second upload of identical bytes never overwrites anything; it is
// recorded as an occurrence. Reads always re-hash the bytes and refuse to return them if they do not match.

import { createHash } from "node:crypto"
import { GridFSBucket, MongoServerError, type Db } from "mongodb"
import type { SourceKind } from "../engine/types"
import { Conflict, IntegrityError, NotFound } from "./errors"

export type SourceArtifact = Readonly<{
  _id: string // SHA-256 of the original bytes
  kind: SourceKind
  filename: string
  size: number
  format: "csv" | "xlsx"
  gridfsId: string
  registeredAt: string
  registeredBy: string
  verifiedAfterWrite: true
}>

export type RegisterResult = Readonly<{ artifact: SourceArtifact; created: boolean }>

export interface SourceStore {
  register(bytes: Uint8Array, meta: { kind: SourceKind; filename: string; format: "csv" | "xlsx"; actor: string; now: string }): Promise<RegisterResult>
  get(sha256: string): Promise<SourceArtifact | null>
  list(): Promise<SourceArtifact[]>
  /** Returns the original bytes after verifying them against the registered SHA-256. */
  read(sha256: string): Promise<{ artifact: SourceArtifact; bytes: Uint8Array }>
}

export const SHA256_PATTERN = /^[0-9a-f]{64}$/

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function verify(artifact: SourceArtifact, bytes: Uint8Array): Uint8Array {
  const actual = sha256(bytes)
  if (actual !== artifact._id || bytes.length !== artifact.size) {
    throw new IntegrityError(`Integrity check failed for ${artifact.filename}: stored bytes no longer match the registered SHA-256. The file was not used.`)
  }
  return bytes
}

export const SOURCE_COLLECTIONS = Object.freeze({
  artifacts: "source_artifacts",
  occurrences: "source_occurrences",
  bucket: "source_files",
})

export class MongoSourceStore implements SourceStore {
  private readonly readDb: () => Promise<Db>
  private readonly writeDb: () => Promise<Db>
  private readonly diagnosticsDb: () => Promise<Db>

  constructor(dbs: { read: () => Promise<Db>; write: () => Promise<Db>; diagnostics: () => Promise<Db> }) {
    this.readDb = dbs.read
    this.writeDb = dbs.write
    this.diagnosticsDb = dbs.diagnostics
  }

  async register(bytes: Uint8Array, meta: { kind: SourceKind; filename: string; format: "csv" | "xlsx"; actor: string; now: string }): Promise<RegisterResult> {
    const id = sha256(bytes)
    const occurrences = (await this.diagnosticsDb()).collection(SOURCE_COLLECTIONS.occurrences)
    const existing = await this.get(id)
    if (existing) {
      if (existing.kind !== meta.kind) throw new Conflict(`These exact bytes are already registered as ${existing.kind} (${existing.filename}).`)
      await occurrences.insertOne({ sha256: id, filename: meta.filename, kind: meta.kind, at: meta.now, by: meta.actor, outcome: "duplicate" })
      return { artifact: existing, created: false }
    }
    const db = await this.writeDb()
    const bucket = new GridFSBucket(db, { bucketName: SOURCE_COLLECTIONS.bucket })
    const upload = bucket.openUploadStream(meta.filename, { metadata: { sha256: id, kind: meta.kind } })
    await new Promise<void>((resolve, reject) => {
      upload.once("finish", () => resolve())
      upload.once("error", reject)
      upload.end(Buffer.from(bytes))
    })
    const gridfsId = upload.id
    // Read back what was stored and re-hash it before the artifact becomes usable.
    const stored = await download(new GridFSBucket(await this.readDb(), { bucketName: SOURCE_COLLECTIONS.bucket }), gridfsId, bytes.length)
    if (sha256(stored) !== id) throw new IntegrityError("The stored copy did not match the uploaded bytes. Registration was abandoned.")
    const artifact: SourceArtifact = {
      _id: id, kind: meta.kind, filename: meta.filename, size: bytes.length, format: meta.format,
      gridfsId: String(gridfsId), registeredAt: meta.now, registeredBy: meta.actor, verifiedAfterWrite: true,
    }
    try {
      await db.collection<SourceArtifact>(SOURCE_COLLECTIONS.artifacts).insertOne(artifact)
    } catch (error) {
      // Concurrent registration of the same bytes: the first record stands; the extra GridFS copy is unreferenced.
      if (error instanceof MongoServerError && error.code === 11000) {
        const winner = await this.get(id)
        if (winner) return { artifact: winner, created: false }
      }
      throw error
    }
    await occurrences.insertOne({ sha256: id, filename: meta.filename, kind: meta.kind, at: meta.now, by: meta.actor, outcome: "registered" })
    return { artifact, created: true }
  }

  async get(id: string): Promise<SourceArtifact | null> {
    if (!SHA256_PATTERN.test(id)) return null
    return (await this.readDb()).collection<SourceArtifact>(SOURCE_COLLECTIONS.artifacts).findOne({ _id: id })
  }

  async list(): Promise<SourceArtifact[]> {
    return (await this.readDb()).collection<SourceArtifact>(SOURCE_COLLECTIONS.artifacts).find({}).sort({ registeredAt: -1 }).limit(500).toArray()
  }

  async read(id: string): Promise<{ artifact: SourceArtifact; bytes: Uint8Array }> {
    const artifact = await this.get(id)
    if (!artifact) throw new NotFound("Source not found")
    const { ObjectId } = await import("mongodb")
    const bucket = new GridFSBucket(await this.readDb(), { bucketName: SOURCE_COLLECTIONS.bucket })
    const bytes = await download(bucket, new ObjectId(artifact.gridfsId), artifact.size)
    return { artifact, bytes: verify(artifact, bytes) }
  }
}

async function download(bucket: GridFSBucket, id: unknown, expectedSize: number): Promise<Uint8Array> {
  const stream = bucket.openDownloadStream(id as never)
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream) {
    total += (chunk as Buffer).length
    if (total > expectedSize) {
      stream.destroy()
      throw new IntegrityError("The stored copy is larger than the registered file.")
    }
    chunks.push(chunk as Buffer)
  }
  return new Uint8Array(Buffer.concat(chunks))
}

/** In-memory implementation with the same contract, for tests. Stored bytes are copies, never views. */
export class MemorySourceStore implements SourceStore {
  private readonly artifacts = new Map<string, SourceArtifact>()
  private readonly blobs = new Map<string, Uint8Array>()
  readonly occurrences: { sha256: string; outcome: string }[] = []

  async register(bytes: Uint8Array, meta: { kind: SourceKind; filename: string; format: "csv" | "xlsx"; actor: string; now: string }): Promise<RegisterResult> {
    const id = sha256(bytes)
    const existing = this.artifacts.get(id)
    if (existing) {
      if (existing.kind !== meta.kind) throw new Conflict(`These exact bytes are already registered as ${existing.kind} (${existing.filename}).`)
      this.occurrences.push({ sha256: id, outcome: "duplicate" })
      return { artifact: existing, created: false }
    }
    this.blobs.set(id, new Uint8Array(bytes))
    const artifact: SourceArtifact = Object.freeze({
      _id: id, kind: meta.kind, filename: meta.filename, size: bytes.length, format: meta.format,
      gridfsId: `mem-${this.artifacts.size + 1}`, registeredAt: meta.now, registeredBy: meta.actor, verifiedAfterWrite: true as const,
    })
    this.artifacts.set(id, artifact)
    this.occurrences.push({ sha256: id, outcome: "registered" })
    return { artifact, created: true }
  }

  async get(id: string) {
    return this.artifacts.get(id) ?? null
  }

  async list() {
    return [...this.artifacts.values()]
  }

  async read(id: string) {
    const artifact = this.artifacts.get(id)
    if (!artifact) throw new NotFound("Source not found")
    return { artifact, bytes: verify(artifact, new Uint8Array(this.blobs.get(id)!)) }
  }
}
