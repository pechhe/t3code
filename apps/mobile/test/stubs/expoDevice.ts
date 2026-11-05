export const DeviceType = { UNKNOWN: 0, PHONE: 1, TABLET: 2, DESKTOP: 3, TV: 4 } as const;
export const osName = "iOS";
export const osVersion = "17.0";
export const modelName = "Test Device";
export const deviceType = DeviceType.PHONE;
export const isDevice = true;
export default { DeviceType, osName, osVersion, modelName, deviceType, isDevice };
