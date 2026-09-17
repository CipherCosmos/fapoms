import { S3Client, ListObjectsV2Command, HeadObjectCommand, type ListObjectsV2CommandOutput } from '@aws-sdk/client-s3';
import { S3StorageService } from './s3-storage.service';
import { documentKey, isSealed } from './document-cipher';

/**
 * ENCRYPT EVERY DOCUMENT THAT WAS STORED BEFORE THE APP ENCRYPTED THEM.
 *
 * New files are encrypted on the way in (`S3StorageService.saveFile`, and `sealObject` at
 * finalize). Everything already in the bucket was written as plaintext — an audit read 123 of 124
 * objects straight off the disk as ordinary PDFs and images — and stays that way until this runs.
 *
 * Safe to run more than once: `sealObject` skips an object that already carries a seal, so a run
 * interrupted halfway is finished by simply running it again. It uses the app's own storage
 * credential and the app's own seal, so there is one implementation of "encrypt a stored object".
 *
 *   docker exec deploy-backend-1 node packages/backend/dist/infrastructure/storage/seal-existing-objects.js
 *
 * Prints counts only — never a key name, which can carry a person's name.
 */
async function main(): Promise<void> {
  if (!documentKey()) {
    console.error('PII_ENCRYPTION_KEY is not set, so there is nothing to encrypt with. Refusing to run.');
    process.exit(2);
  }

  const env = (key: string, fallback?: string) => process.env[key] ?? fallback;
  const config = { get: <T>(key: string, fallback?: T) => (env(key) as unknown as T) ?? fallback } as never;
  const storage = new S3StorageService(config);
  const bucket = env('S3_BUCKET_NAME', 'fapoms-documents')!;
  const client: S3Client = (storage as unknown as { client: S3Client }).client;

  let seen = 0;
  let sealed = 0;
  let already = 0;
  let failed = 0;
  let token: string | undefined;
  do {
    const page: ListObjectsV2CommandOutput = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const object of page.Contents ?? []) {
      if (!object.Key) continue;
      seen++;
      try {
        if (await storage.sealObject(object.Key)) sealed++;
        else already++;
      } catch (err) {
        failed++;
        console.error(`object #${seen} could not be sealed: ${(err as Error).name}`);
      }
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  // Re-read every object's seal, rather than trusting the counters above.
  let verified = 0;
  token = undefined;
  do {
    const page: ListObjectsV2CommandOutput = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    for (const object of page.Contents ?? []) {
      if (!object.Key) continue;
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: object.Key }));
      if (isSealed(head.Metadata)) verified++;
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);

  console.log(JSON.stringify({ objects: seen, sealedNow: sealed, alreadySealed: already, failed, verifiedSealed: verified }));
  process.exit(failed > 0 || verified !== seen ? 1 : 0);
}

if (require.main === module) {
  void main().catch((err) => {
    console.error(`seal-existing-objects failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
