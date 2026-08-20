import { Injectable, Logger, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { Socket } from 'net';

export interface ScanResult {
  clean: boolean;
  signature?: string;
}

/**
 * Antivirus scanning for every file that enters the application — chat attachments, audit documents,
 * KYC photos, Excel imports, chunked and presigned uploads. Staff and assayers open these files, so an
 * unscanned upload path is a real malware vector into the organization.
 *
 * Backed by ClamAV's `clamd` over TCP (INSTREAM), which most deployments run as a sidecar. Behaviour:
 * - The EICAR industry test signature is always caught, even with no scanner configured, so the wiring
 *   is verifiable end to end and the canonical test file never slips through.
 * - With `CLAMAV_HOST` set, the buffer is streamed to clamd and rejected on any signature hit.
 * - With no scanner configured: in normal mode uploads pass with a loud warning (dev-friendly); set
 *   `FILE_SCAN_REQUIRED=true` to fail closed instead, so a locked-down environment refuses to accept a
 *   file it cannot scan. A scanner error is treated the same way (fail-open with a warning unless
 *   scanning is required).
 */
@Injectable()
export class FileScanService {
  private readonly logger = new Logger(FileScanService.name);
  private readonly host = process.env.CLAMAV_HOST;
  private readonly port = Number(process.env.CLAMAV_PORT) || 3310;
  /**
   * Whether a scan that cannot confirm a file is clean should REFUSE the file (fail closed)
   * rather than let it through (fail open).
   *
   * `FILE_SCAN_REQUIRED` wins if set either way. When it is unset, the default is "required iff
   * a scanner is configured": if you took the trouble to point `CLAMAV_HOST` at clamd, a
   * transient scan error should fail closed — you clearly intend files to be scanned, and
   * silently admitting an unscanned file defeats the point. If no scanner is configured at all,
   * this stays false so uploads keep working (a deployment without clamd is not forced to reject
   * every file); the loud startup warning below is what surfaces that gap instead.
   */
  private readonly required = process.env.FILE_SCAN_REQUIRED
    ? process.env.FILE_SCAN_REQUIRED === 'true'
    : !!process.env.CLAMAV_HOST;
  private readonly timeoutMs = Number(process.env.CLAMAV_TIMEOUT_MS) || 15000;

  constructor() {
    // In production, a system serving bank audit documents with NO malware scanner is a
    // standing risk that must not be silent. Warn once at boot — not fatal, because forcing
    // every upload to fail when clamd is merely not deployed yet would be its own outage, and
    // that is a deployment decision, not something this process should make by refusing to start.
    if (process.env.NODE_ENV === 'production' && !this.host) {
      this.logger.warn(
        'No CLAMAV_HOST configured — uploaded documents are NOT being malware-scanned. ' +
          'Configure clamd and set CLAMAV_HOST, or set FILE_SCAN_REQUIRED=true to reject uploads until it is.',
      );
    }
  }

  // The EICAR anti-malware test string (not real malware) — its presence proves the pipe works.
  private static readonly EICAR =
    'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

  /** Scan a buffer. Never throws for a clean/uncertain file unless scanning is required. */
  async scanBuffer(buffer: Buffer, filename?: string): Promise<ScanResult> {
    if (!buffer || buffer.length === 0) return { clean: true };

    // Always-on EICAR guard, independent of clamd.
    if (buffer.includes(Buffer.from(FileScanService.EICAR))) {
      return { clean: false, signature: 'Eicar-Test-Signature' };
    }

    if (!this.host) {
      if (this.required) {
        throw new ServiceUnavailableException('File scanning is required but no scanner is configured.');
      }
      this.logger.warn(
        `No CLAMAV_HOST configured — "${filename ?? 'upload'}" was NOT malware-scanned. Set CLAMAV_HOST in production.`,
      );
      return { clean: true };
    }

    try {
      const signature = await this.clamdInstream(buffer);
      return signature ? { clean: false, signature } : { clean: true };
    } catch (err: any) {
      this.logger.error(`Malware scan failed for "${filename ?? 'upload'}": ${err?.message}`);
      if (this.required) {
        throw new ServiceUnavailableException('File could not be scanned right now; please retry.');
      }
      return { clean: true };
    }
  }

  /** Scan and throw a 400 if the file is infected. The convenience call for upload handlers. */
  async scanOrThrow(buffer: Buffer, filename?: string): Promise<void> {
    const result = await this.scanBuffer(buffer, filename);
    if (!result.clean) {
      this.logger.warn(`Rejected infected upload "${filename ?? 'upload'}": ${result.signature}`);
      throw new BadRequestException(
        `This file was rejected by malware scanning${result.signature ? ` (${result.signature})` : ''}. ` +
          'If you believe this is a mistake, contact your administrator.',
      );
    }
  }

  /** Parse a clamd response line into a signature name, or null when the stream is clean. */
  static interpretResponse(raw: string): string | null {
    const line = raw.replace(/\0/g, '').trim(); // e.g. "stream: OK" or "stream: Eicar-Test-Signature FOUND"
    if (/\bFOUND\b/.test(line)) {
      const m = /stream:\s*(.+?)\s+FOUND/.exec(line);
      return m ? m[1] : 'threat';
    }
    return null;
  }

  /**
   * Stream a buffer to clamd using the INSTREAM protocol: `zINSTREAM\0`, then repeated
   * `<uint32 length><bytes>` chunks, terminated by a zero-length chunk. clamd replies with
   * `stream: OK` or `stream: <signature> FOUND`.
   */
  private clamdInstream(buffer: Buffer): Promise<string | null> {
    return new Promise<string | null>((resolve, reject) => {
      const socket = new Socket();
      const chunks: Buffer[] = [];
      let settled = false;
      const done = (err: Error | null, sig?: string | null) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) reject(err);
        else resolve(sig ?? null);
      };

      socket.setTimeout(this.timeoutMs);
      socket.on('timeout', () => done(new Error('clamd scan timed out')));
      socket.on('error', (err) => done(err));
      socket.on('data', (d) => chunks.push(d));
      socket.on('end', () => done(null, FileScanService.interpretResponse(Buffer.concat(chunks).toString('utf8'))));

      socket.connect(this.port, this.host as string, () => {
        socket.write('zINSTREAM\0');
        const CHUNK = 64 * 1024;
        for (let i = 0; i < buffer.length; i += CHUNK) {
          const slice = buffer.subarray(i, i + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(slice.length, 0);
          socket.write(len);
          socket.write(slice);
        }
        socket.write(Buffer.from([0, 0, 0, 0])); // zero-length chunk terminates the stream
      });
    });
  }
}
