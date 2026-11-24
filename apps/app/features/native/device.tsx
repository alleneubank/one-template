// web has no swift or kotlin: the same api in typescript. ios and android
// resolve device.ios.ts and device.android.ts instead.
export const Device = {
  async info(): Promise<Record<string, string>> {
    return { language: 'TypeScript', model: 'Browser', system: 'Web' }
  },
}
