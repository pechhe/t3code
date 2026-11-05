/** Node stand-in for expo-secure-store: an in-memory keychain. */
const store = new Map<string, string>();
export const getItemAsync = async (key: string): Promise<string | null> => store.get(key) ?? null;
export const setItemAsync = async (key: string, value: string): Promise<void> => {
  store.set(key, value);
};
export const deleteItemAsync = async (key: string): Promise<void> => {
  store.delete(key);
};
export const isAvailableAsync = async (): Promise<boolean> => true;
export const getItem = (key: string): string | null => store.get(key) ?? null;
export const setItem = (key: string, value: string): void => {
  store.set(key, value);
};
export const deleteItem = (key: string): void => {
  store.delete(key);
};
export const WHEN_UNLOCKED = "WHEN_UNLOCKED";
export const WHEN_UNLOCKED_THIS_DEVICE_ONLY = "WHEN_UNLOCKED_THIS_DEVICE_ONLY";
export const AFTER_FIRST_UNLOCK = "AFTER_FIRST_UNLOCK";
export const AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY = "AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY";
export const ALWAYS = "ALWAYS";
export const ALWAYS_THIS_DEVICE_ONLY = "ALWAYS_THIS_DEVICE_ONLY";
export const WHEN_PASSCODE_SET_THIS_DEVICE_ONLY = "WHEN_PASSCODE_SET_THIS_DEVICE_ONLY";
export const SecureStoreAccessibility = {
  WHEN_UNLOCKED,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  AFTER_FIRST_UNLOCK,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  ALWAYS,
  ALWAYS_THIS_DEVICE_ONLY,
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
};
