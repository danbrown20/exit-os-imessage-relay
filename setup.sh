#!/bin/bash
# Exit OS iMessage Relay - Quick Setup
# Run: curl -sL https://raw.githubusercontent.com/your-repo/main/setup.sh | bash

cd ~
git clone https://github.com/victory-cleaning/exit-os-imessage-relay.git
cd exit-os-imessage-relay
npm install
cp .env.example .env

# Start with PM2
pm2 start index.js --name imessage-daemon
pm2 save

echo "✅ iMessage relay started! Check: pm2 logs imessage-daemon"
