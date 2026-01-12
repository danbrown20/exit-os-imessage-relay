# Exit OS iMessage Relay

Polls Mac Messages database and forwards business-relevant messages to Exit OS.

## Quick Install (on Mac Mini)

\\\ash
git clone https://github.com/victory-cleaning/exit-os-imessage-relay.git
cd exit-os-imessage-relay
npm install
cp .env.example .env
pm2 start index.js --name imessage-daemon
pm2 save
\\\

## Health Check

http://localhost:5088/health
