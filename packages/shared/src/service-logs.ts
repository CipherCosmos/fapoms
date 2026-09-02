/**
 * The service-log viewer's vocabulary: which services may be read, and what a log line is.
 *
 * This exists because the people who need the logs cannot reach the machine holding them. The
 * box is administered by someone else, so every question that ends in "what did the backend say
 * at 14:32?" costs a message to a third party and a wait. The platform already knows who is an
 * administrator; it can answer that question itself.
 *
 * The catalogue is an ALLOWLIST, and that is the point of it. The API resolves a service name
 * from this list to a container, and refuses anything else — so a caller cannot ask for an
 * arbitrary container on the host by inventing a name or pasting an id. Services absent from the
 * running stack are simply not offered.
 */

/** Which of a container's two output streams a line came from. */
export type LogStream = 'stdout' | 'stderr';

export interface LogServiceDescriptor {
  /** Compose service name — matches the `com.docker.compose.service` label on the container. */
  readonly service: string;
  /** What to call it on screen. */
  readonly label: string;
  /** What an administrator should understand this service to be, before they read its output. */
  readonly description: string;
}

/**
 * Every service either stack can run. The API intersects this with what is actually up, so one
 * list covers the production stack (caddy, no mobile) and the bind-mounted one (mobile and
 * livekit, no caddy) without either needing its own copy.
 */
export const LOG_SERVICES: readonly LogServiceDescriptor[] = [
  { service: 'backend',   label: 'Backend API',      description: 'NestJS — HTTP, websockets, queues and workers.' },
  { service: 'frontend',  label: 'Web app',          description: 'The web bundle: Vite in development, nginx in production.' },
  { service: 'postgres',  label: 'PostgreSQL',       description: 'The system of record. Slow queries and connection errors surface here.' },
  { service: 'redis',     label: 'Redis',            description: 'Queues, cache and rate-limit counters.' },
  { service: 'minio',     label: 'Object storage',   description: 'MinIO, where documents and attachments live when S3 is not in use.' },
  { service: 'livekit',   label: 'LiveKit',          description: 'Voice calls. ICE and TURN failures appear here, not in the backend.' },
  { service: 'mobile',    label: 'Mobile bundler',   description: 'Expo/Metro, serving the field app in development.' },
  { service: 'caddy',     label: 'Caddy',            description: 'The reverse proxy, in deployments that terminate TLS themselves.' },
  { service: 'nominatim', label: 'Nominatim',        description: 'Self-hosted geocoder, when the stack runs one.' },
  { service: 'osrm',      label: 'OSRM',             description: 'Self-hosted road router, when the stack runs one.' },
  { service: 'clamav',    label: 'ClamAV',           description: 'Upload virus scanning, when enabled.' },
] as const;

export const LOG_SERVICE_NAMES: readonly string[] = LOG_SERVICES.map((s) => s.service);

export function isKnownLogService(name: string): boolean {
  return LOG_SERVICE_NAMES.includes(name);
}

/** One line of container output, already de-multiplexed and redacted. */
export interface LogLine {
  /**
   * The container's own timestamp, ISO-8601, or null when Docker had none to give. Kept as the
   * string Docker produced rather than a Date so that ordering and display never depend on the
   * reader's timezone — the box runs UTC and the person reading may not.
   */
  readonly ts: string | null;
  readonly stream: LogStream;
  readonly text: string;
}

export interface ServiceLogsQuery {
  /** How many lines back from now. */
  readonly tail?: number;
  /** ISO-8601, or a relative shorthand the API understands ('15m', '2h', '3d'). */
  readonly since?: string;
  readonly until?: string;
  /** Case-insensitive substring filter, applied server-side so the cap counts matching lines. */
  readonly q?: string;
}

export interface ServiceLogsPage {
  readonly service: string;
  readonly lines: readonly LogLine[];
  /** True when the response hit a cap and older lines exist beyond it. */
  readonly truncated: boolean;
  /** Whether the container is currently running — an empty log reads very differently if not. */
  readonly running: boolean;
  /**
   * When the container was created. Logs do not survive a container being replaced, so this is
   * the honest floor on how far back `since` can reach, and the page says so rather than
   * presenting an empty result as "nothing happened".
   */
  readonly containerStartedAt: string | null;
}

/** Defaults and ceilings, shared so the client cannot ask for something the API will refuse. */
export const LOG_TAIL_DEFAULT = 500;
export const LOG_TAIL_MAX = 20_000;
/** A hard ceiling on a single response, independent of line count — one line can be enormous. */
export const LOG_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
/** How long a live stream stays open before the client must re-establish it. */
export const LOG_STREAM_MAX_SECONDS = 30 * 60;
