const { app } = require('./app');
const { ensureSchema } = require('./db');
const { startWorker } = require('./worker');

const port = process.env.PORT || 3000;
ensureSchema().then(() => {
  const server = app.listen(port, () => console.log('Listening on http://localhost:' + port));
  const stopWorker = startWorker(); // background outbox processing (notifications)
  process.on('SIGTERM', () => { stopWorker(); server.close(); });
}).catch((e) => { console.error('Startup failed:', e.message); process.exit(1); });
