module.exports = {
  apps: [{
    name: 'exit-os-relay',
    script: 'index.js',
    interpreter: '/opt/homebrew/opt/node@20/bin/node',
    cwd: '/Users/adforge/exit-os-imessage-relay',
    env: {
      HOME: '/Users/adforge'
    }
  }]
};
