module.exports = {
  apps : [{
    name   : "engine",
    script : "./dist/src/index.js",
    // Time for a clean shutdown (SIGINT handler) before pm2 kills the Engine,
    // also at idea02's 05:00 reboot; pm2's default is 1.6 s (idea#128)
    kill_timeout: 10000,
    // engine#567: a crash loop backs off instead of spinning (kind-panda restarted 817x
    // about every 1.7 s, hot, for weeks). pm2 waits 1 s, then x1.5 per failed start up to
    // its 15 s cap, and resets the delay after 30 s up. NO max_restarts: an offline kit
    // must keep retrying (and engine#512's exit 75 relies on a restart). Keep min_uptime
    // well below 10 s: pm2 stops an app for good (ERRORED) after max_restarts (default 16)
    // starts shorter than min_uptime within min_uptime x 16 ms of its first start; with
    // this backoff that happens from ~10 s on (test/automated/pm2-crash-backoff.test.ts).
    exp_backoff_restart_delay: 1000,
    min_uptime: 5000,
    // env is the default environment
    env: {
       NODE_ENV: "development",
       VERBOSITY: "3" 
    },
    env_production: {
       NODE_ENV: "production"
    },
    env_development: {
       NODE_ENV: "development",
       VERBOSITY: "3" 
    }
  }, {
    // idea-usage (idea#411): separate process so a hung hook cannot stall the Engine.
    name   : "idea-usage",
    script : "./dist/src/usage/main.js",
    kill_timeout: 10000,
    // engine#567: same backoff as the Engine
    exp_backoff_restart_delay: 1000,
    min_uptime: 5000,
    env: {
       NODE_ENV: "development",
       VERBOSITY: "3"
    },
    env_production: {
       NODE_ENV: "production"
    },
    env_development: {
       NODE_ENV: "development",
       VERBOSITY: "3"
    }
  }]
}
