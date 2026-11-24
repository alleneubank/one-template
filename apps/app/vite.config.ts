import { defineConfig } from 'vite'
import { one } from 'one/vite'
import { appIdentity } from './app.identity.ts'

// silo assigns WEB_PORT per worktree; native runs read server.port to find this dev server.
const webPort = Number(process.env.WEB_PORT ?? 8081)

export default defineConfig({
  server: { port: webPort },
  plugins: [
    one({
      web: {
        defaultRenderMode: 'ssg',
      },

      // pages, api routes, and middlewares build against one server config
      build: {
        server: { unified: true },
      },

      native: {
        app: {
          name: appIdentity.name,
          icon: {
            source: './public/app-icon.png',
            backgroundColor: '#000000',
          },
          splash: {
            source: './public/splash.png',
            backgroundColor: '#000000',
            width: 200,
          },
          ios: {
            bundleId: appIdentity.id,
            deploymentTarget: '17.0',
          },
          android: { applicationId: appIdentity.id },
        },
      },
    }),
  ],
})
