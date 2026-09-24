/**
 * Android / web: no Firebase messaging here — Android keeps the existing push path
 * (`registerForPushNotificationsAsync`). The iPhone implementation is `push-ios.ios.ts`; Metro
 * picks it by platform, so the Android bundle does not carry React Native Firebase at all.
 * Same exports, all no-ops.
 */
export function iosPushAvailable(): boolean {
  return false;
}

export function setIosBackgroundHandler(_handler: (data: unknown) => Promise<void>): void {}

export async function registerIosPush(): Promise<void> {}

export function listenIosPush(_handlers: { onData: (data: unknown) => void; onTap: (data: unknown) => void }): () => void {
  return () => undefined;
}

export async function initialIosTap(): Promise<unknown | null> {
  return null;
}
