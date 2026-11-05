/** Node stand-in for expo-modules-core: no native registry exists in a test process. */
export class SharedObject {}
export class SharedRef {}
export class NativeModule {}
export class EventEmitter {
  addListener(): { remove(): void } {
    return { remove: () => undefined };
  }
  removeAllListeners(): void {}
  emit(): void {}
}
export const requireNativeModule = (): unknown => ({});
export const requireOptionalNativeModule = (): unknown => null;
export const requireNativeView = (): unknown => () => null;
export const NativeModulesProxy = {};
export const ModulesProxy = {};
export const Platform = { OS: "ios" as const };
export const uuid = { v4: () => "00000000-0000-4000-8000-000000000000" };
export const isRunningInExpoGo = (): boolean => false;
export const CodedError = class extends Error {};
export const UnavailabilityError = class extends Error {};
export const registerWebModule = <T>(module: T): T => module;
export const ensureNativeModulesAreInstalled = (): void => undefined;
