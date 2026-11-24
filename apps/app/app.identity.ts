// The native app's identity. `bun run setup` rewrites both values; vite.config.ts
// and scripts/verify.ts read them from here.
export const appIdentity = {
  // Xcode project and scheme, and the Android app name.
  name: 'TemplateApp',
  // iOS bundle id and Android application id.
  id: 'dev.template.app',
} as const
