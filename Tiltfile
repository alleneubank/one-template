# Start through `silo up`: silo assigns WEB_PORT per worktree and exports it here.
web_port = os.getenv('WEB_PORT')
if not web_port:
    fail('WEB_PORT is unset; start this stack with `silo up`')

# vite.config.ts reads WEB_PORT, so `one dev` serves on the port silo assigned.
local_resource(
    'app',
    serve_cmd = 'bun run dev',
    serve_dir = 'apps/app',
    readiness_probe = probe(
        period_secs = 2,
        http_get = http_get_action(port = int(web_port), path = '/status'),
    ),
    links = [link('http://localhost:%s' % web_port, 'app')],
)
