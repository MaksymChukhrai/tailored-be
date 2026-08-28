import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../config/configuration';
import type { StorageProvider, UploadResult } from './storage.interface';

@Injectable()
export class StorageService implements StorageProvider {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;
  private readonly bucketName: string;

  public constructor(private readonly configService: ConfigService<AppConfig, true>) {
    const r2Config = this.configService.get('r2', { infer: true });
    this.bucketName = r2Config.bucketName;

    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${r2Config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: r2Config.accessKeyId,
        secretAccessKey: r2Config.secretAccessKey,
      },
    });
  }

  public async upload(params: {
    key: string;
    body: Buffer;
    contentType: string;
  }): Promise<UploadResult> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: params.key,
          Body: params.body,
          ContentType: params.contentType,
        }),
      );
      return { storageKey: params.key };
    } catch (error: unknown) {
      this.logger.error(`Failed to upload object "${params.key}"`, error);
      throw new InternalServerErrorException('Failed to upload file to storage');
    }
  }

  public async getSignedDownloadUrl(
    key: string,
    expiresInSeconds = 300,
  ): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: key,
      });
      return await getSignedUrl(this.client, command, {
        expiresIn: expiresInSeconds,
      });
    } catch (error: unknown) {
      this.logger.error(`Failed to sign download URL for "${key}"`, error);
      throw new InternalServerErrorException('Failed to generate download link');
    }
  }

  public async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
    } catch (error: unknown) {
      this.logger.error(`Failed to delete object "${key}"`, error);
      throw new InternalServerErrorException('Failed to delete file from storage');
    }
  }

  public async deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    try {
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucketName,
          Delete: {
            Objects: keys.map((key) => ({ Key: key })),
          },
        }),
      );
    } catch (error: unknown) {
      this.logger.error(`Failed to bulk delete ${keys.length} objects`, error);
      throw new InternalServerErrorException('Failed to delete files from storage');
    }
  }
}
