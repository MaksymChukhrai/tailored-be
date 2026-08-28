export interface UploadResult {
  storageKey: string;
}

export interface StorageProvider {
  upload(params: {
    key: string;
    body: Buffer;
    contentType: string;
  }): Promise<UploadResult>;

  getSignedDownloadUrl(key: string, expiresInSeconds?: number): Promise<string>;

  delete(key: string): Promise<void>;

  deleteMany(keys: string[]): Promise<void>;
}

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
