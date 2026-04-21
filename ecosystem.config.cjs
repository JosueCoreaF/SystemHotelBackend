module.exports = {
  apps: [
    {
      name: "verona-server",
      script: "./dist/server.js",
      exec_mode: "fork",
      instances: 1,
      env: {
        NODE_ENV: "production",
      },
      max_memory_restart: "300M",
      watch: false,
      autorestart: true,
    },
    {
      name: "verona-tunnel",
      script: "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
      args: "tunnel run hotel-verona",
      exp_backoff_restart_delay: 100,
      autorestart: true,
    },
  ],
}
