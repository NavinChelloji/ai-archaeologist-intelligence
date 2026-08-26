import { buffer as consumeToBuffer } from "node:stream/consumers";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { AppError } from "@aca/contracts";
import { getObjectStream, type S3Client } from "@aca/storage";
import { APP_CONFIG } from "../../config/config.module";
import type { AiEnv } from "../../config/env";
import { S3_CLIENT } from "../../shared/infra.module";

/**
 * The manifest shape written by the indexer's Parser module at
 * `repo.files.indexed` (REPOSITORY_PROCESSOR_SERVICE_PLAN.md) — validated
 * on read since it crosses a deployable boundary via S3, not a queue
 * payload, so `@aca/contracts` doesn't already enforce its shape.
 */
const ManifestFileEntrySchema = z.object({
  fileId: z.string().uuid(),
  path: z.string(),
  language: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  lineCount: z.number().int().nonnegative(),
  contentHash: z.string(),
  objectKey: z.string(),
});
export type ManifestFileEntry = z.infer<typeof ManifestFileEntrySchema>;

const ManifestSchema = z.object({
  repoId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  commitSha: z.string(),
  generatedAt: z.string(),
  files: z.array(ManifestFileEntrySchema),
});
export type Manifest = z.infer<typeof ManifestSchema>;

/**
 * Reads exactly what the pipeline flow chart promises `ai` gets — the
 * snapshot's manifest and each listed file's text (SEARCH_EMBEDDING_SERVICE_PLAN.md
 * "Manifest ... Fetch text objects for changed files"). The manifest already
 * excludes ignored/binary/secret-matching files (Stage 5's filtering), so
 * reading only what it lists is by construction "never embed excluded files."
 */
@Injectable()
export class ManifestReaderService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AiEnv,
    @Inject(S3_CLIENT) private readonly s3: S3Client
  ) {}

  async readManifest(manifestKey: string): Promise<Manifest> {
    const text = await this.readText(manifestKey);
    const parsed = ManifestSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      throw new AppError("SNAPSHOT_DOWNLOAD_FAILED", "The snapshot manifest is malformed.", {
        details: { issues: parsed.error.issues.map((i) => i.message) },
      });
    }
    return parsed.data;
  }

  async readFileContent(objectKey: string): Promise<string> {
    return this.readText(objectKey);
  }

  private async readText(key: string): Promise<string> {
    const stream = await getObjectStream(this.s3, this.config.S3_BUCKET, key);
    return (await consumeToBuffer(stream)).toString("utf8");
  }
}
