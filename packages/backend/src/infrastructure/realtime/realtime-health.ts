/**
 * Boot-time health of the Socket.IO Redis adapter, shared between bootstrap (which sets it) and
 * the readiness probe (which reads it).
 *
 * If Redis was configured but the adapter failed to connect at boot, the process silently fell
 * back to the single-node in-memory adapter — and its realtime is then broken for any
 * cross-replica delivery. Previously that only logged a warning, so an orchestrator kept routing
 * clients to a replica serving broken realtime. Readiness now reports it as degraded, so the
 * replica is pulled from rotation (and a Redis outage at deploy time fails loudly rather than
 * quietly capping the whole system at one node). Assessment §8 / P1.
 */
export const realtimeHealth = {
  /** True once REDIS_HOST is configured — i.e. multi-node realtime is intended. */
  redisConfigured: false,
  /** True unless the adapter failed to connect at boot. */
  redisAdapterConnected: true,
};
