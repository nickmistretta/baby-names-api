// Thin entry point for cron jobs or manual triggers.
// Accepts POST { email, type } and delegates to send-sequences.
module.exports = require('./send-sequences');
