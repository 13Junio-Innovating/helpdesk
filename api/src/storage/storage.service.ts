import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  GetObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../config/env.js';

/**
 * Acesso ao S3-compatível. Dois clientes: um interno (HEAD/DELETE pela rede do servidor) e um
 * "público" só para assinar URLs com o host que o navegador alcança (em dev, localhost).
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly internal: S3Client;
  private readonly signer: S3Client;
  readonly bucket: string;

  constructor(private readonly config: ConfigService<Env, true>) {
    const base = {
      region: config.get('S3_REGION', { infer: true }),
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
      credentials: { accessKeyId: config.get('S3_ACCESS_KEY', { infer: true }), secretAccessKey: config.get('S3_SECRET_KEY', { infer: true }) },
    };
    const endpoint = config.get('S3_ENDPOINT', { infer: true });
    this.internal = new S3Client({ ...base, endpoint });
    this.signer = new S3Client({ ...base, endpoint: config.get('S3_PUBLIC_ENDPOINT', { infer: true }) ?? endpoint });
    this.bucket = config.get('S3_BUCKET', { infer: true });
  }

  async onModuleInit(): Promise<void> {
    if (!this.config.get('S3_AUTO_CREATE_BUCKET', { infer: true })) return;
    try {
      await this.internal.send(new HeadBucketCommand({ Bucket: this.bucket })).catch(async () => {
        await this.internal.send(new CreateBucketCommand({ Bucket: this.bucket }));
      });
      const origins = this.config.get('CORS_ORIGIN', { infer: true }).split(',').map((o) => o.trim());
      await this.internal.send(new PutBucketCorsCommand({
        Bucket: this.bucket,
        CORSConfiguration: { CORSRules: [{ AllowedOrigins: origins, AllowedMethods: ['PUT', 'GET'], AllowedHeaders: ['*'], MaxAgeSeconds: 3600 }] },
      }));
    } catch (e) {
      // sem S3 em dev a API sobe mesmo assim; só os anexos falham
      this.logger.warn(`bucket ${this.bucket} indisponível: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** PUT pré-assinado: tipo e tamanho fazem parte da assinatura (o S3 recusa um arquivo diferente). */
  presignUpload(key: string, contentType: string, size: number, expiresIn = 600): Promise<string> {
    return getSignedUrl(this.signer, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: contentType, ContentLength: size }), { expiresIn });
  }

  presignDownload(key: string, filename: string, expiresIn = 300): Promise<string> {
    const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    return getSignedUrl(
      this.signer,
      new GetObjectCommand({ Bucket: this.bucket, Key: key, ResponseContentDisposition: `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}` }),
      { expiresIn },
    );
  }

  async head(key: string): Promise<{ size: number; contentType: string | undefined } | null> {
    try {
      const h = await this.internal.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { size: h.ContentLength ?? 0, contentType: h.ContentType };
    } catch {
      return null;
    }
  }

  async remove(key: string): Promise<void> {
    await this.internal.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })).catch(() => undefined);
  }
}
