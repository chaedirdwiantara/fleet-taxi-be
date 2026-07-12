import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { Env } from '../config/env';

/**
 * Import/export file storage: local disk in dev, S3 in production
 * (import/fleet-monitoring/<YYYY-MM>/… — brief §8). Keys are always
 * forward-slash relative paths.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly useS3: boolean;
  private readonly bucket: string | undefined;
  private readonly s3: S3Client | undefined;
  private readonly localRoot: string;

  constructor(config: ConfigService<Env, true>) {
    const isProd = config.get('NODE_ENV', { infer: true }) === 'production';
    this.bucket = config.get('S3_BUCKET', { infer: true });
    this.useS3 = isProd && !!this.bucket;
    this.localRoot = resolve(process.cwd(), 'storage');
    if (this.useS3) {
      this.s3 = new S3Client({ region: config.get('S3_REGION', { infer: true }) });
    } else {
      this.logger.log(`Using local disk storage at ${this.localRoot}`);
    }
  }

  private localPath(key: string): string {
    const full = normalize(join(this.localRoot, key));
    if (!full.startsWith(this.localRoot + sep)) throw new Error(`Invalid storage key: ${key}`);
    return full;
  }

  async save(key: string, body: Buffer): Promise<void> {
    if (this.useS3) {
      await this.s3!.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body }));
      return;
    }
    const path = this.localPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async read(key: string): Promise<Buffer> {
    if (this.useS3) {
      const res = await this.s3!.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!res.Body) throw new NotFoundException(`File not found: ${key}`);
      const chunks: Buffer[] = [];
      for await (const chunk of res.Body as Readable) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks);
    }
    try {
      return await readFile(this.localPath(key));
    } catch {
      throw new NotFoundException(`File not found: ${key}`);
    }
  }

  async delete(key: string): Promise<void> {
    if (this.useS3) return; // keep originals in S3; lifecycle rules handle expiry
    await unlink(this.localPath(key)).catch(() => undefined);
  }

  /** Whether media flows go direct-to-S3 (prod) or through the API's local sink (dev). */
  isS3(): boolean {
    return this.useS3;
  }

  /**
   * Presigned PUT for direct client→S3 upload. ContentType and ContentLength
   * are part of the signature, so S3 rejects a PUT with different values —
   * this is the server-side size/type enforcement.
   */
  async presignPut(
    key: string,
    contentType: string,
    contentLength: number,
    ttlSec = 300,
  ): Promise<string> {
    return getSignedUrl(
      this.s3!,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
        ContentLength: contentLength,
      }),
      { expiresIn: ttlSec },
    );
  }

  /** Presigned GET for viewing media; regenerated on every detail fetch. */
  async presignGet(key: string, ttlSec = 600): Promise<string> {
    return getSignedUrl(this.s3!, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttlSec,
    });
  }

  /** Object metadata, or null when it doesn't exist (used by upload confirm). */
  async head(key: string): Promise<{ size: number } | null> {
    if (this.useS3) {
      try {
        const res = await this.s3!.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
        return { size: res.ContentLength ?? 0 };
      } catch {
        return null;
      }
    }
    try {
      const s = await stat(this.localPath(key));
      return { size: s.size };
    } catch {
      return null;
    }
  }
}
