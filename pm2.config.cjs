module.exports = {
  apps : [{
    name   : "engine",
    script : "./dist/src/index.js",
    // Time for a clean shutdown (SIGINT handler) before pm2 kills the Engine,
    // also at idea02's 05:00 reboot; pm2's default is 1.6 s (idea#128)
    kill_timeout: 10000,
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
