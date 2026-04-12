// Vercel cron job — runs every hour via vercel.json schedule
// Delegates to send-sequences queue processor
const processQueue = require('./send-sequences');

module.exports = async function handler(req, res) {
  // Vercel cron sends GET requests; forward directly to the queue processor
  return processQueue({ ...req, method: 'GET' }, res);
};
