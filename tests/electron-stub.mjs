// Stand-in for the electron module when main-process code runs under plain Node in tests.
export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s) => Buffer.from(s),
  decryptString: (b) => b.toString(),
}
export const app = { getVersion: () => "test", getPath: () => ".", isPackaged: false, getAppPath: () => process.cwd() }
export const shell = { openExternal: async () => undefined }
export default { safeStorage, app, shell }
