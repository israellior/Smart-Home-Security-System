/**
 * Email channel - the fallback for people who haven't granted push
 * permission, and the only sensible carrier for the daily summary.
 *
 * NOT IMPLEMENTED YET, same as webPush. The recipient's address is
 * already loaded and passed in; this module only has to send.
 *
 * To finish it:
 *   1. pick a transport - nodemailer with SMTP, or an API client for
 *      Resend / SendGrid / SES
 *   2. put the credentials in .env and extend isConfigured()
 *   3. replace the body of send()
 *
 * Worth knowing when you do: unlike push, most email providers accept a
 * batch in one request. That's why send() receives the whole recipient
 * list rather than being called once per person - a batching channel can
 * use it, and a non-batching one just loops.
 */
export const name = 'email';

export function isConfigured() {
  return Boolean(process.env.SMTP_URL || process.env.EMAIL_API_KEY);
}

/**
 * @param {object} payload  { title, body, url, device, event }
 * @param {Array}  recipients  [{ user, subscriptions }]
 * @returns {Array} [{ userId, status, reason }] - one per recipient
 */
export async function send(payload, recipients) {
  if (!isConfigured()) {
    return recipients.map((r) => ({
      userId: r.user._id,
      status: 'skipped',
      reason: 'email not configured (no SMTP_URL or EMAIL_API_KEY)'
    }));
  }

  return recipients.map((r) => {
    console.log(`[email] would send to ${r.user.email}: ${payload.title} - ${payload.body}`);
    return {
      userId: r.user._id,
      status: 'skipped',
      reason: 'email send() not implemented yet'
    };
  });
}
