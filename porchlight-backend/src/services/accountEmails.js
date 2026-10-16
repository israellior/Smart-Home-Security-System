import { sendMail } from '../config/mail.js';

/**
 * The two emails an account gets about itself. Plain text first - it is
 * what a careful reader checks and what every client can show - with a
 * small HTML version in the app's day-porch colours alongside.
 *
 * Inline styles and a table because that is still what email clients
 * render consistently; nothing here loads from the network, so a client
 * that blocks remote images shows the same message.
 */

// The browser origin is also where the app lives. One value, so the link
// in an email can never point somewhere CORS would not let the app run.
function appUrl() {
  return (process.env.CLIENT_ORIGIN || 'http://localhost:5173').replace(/\/$/, '');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'there';
}

function layout({ heading, paragraphs, button, footnote }) {
  const body = paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#1C1712;">${p}</p>`)
    .join('');

  const cta = button
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(button.href)}" style="display:inline-block;background:#A9762F;color:#EDE7DB;text-decoration:none;font-size:15px;padding:12px 22px;border-radius:10px;">${escapeHtml(button.label)}</a></p>`
    : '';

  const note = footnote
    ? `<p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#6B6153;">${footnote}</p>`
    : '';

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#EDE7DB;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EDE7DB;padding:32px 16px;font-family:'IBM Plex Sans',Helvetica,Arial,sans-serif;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#E3DBC8;border-radius:14px;padding:32px 28px;">
<tr><td>
<p style="margin:0 0 24px;font-family:Georgia,serif;font-size:22px;color:#1C1712;">Porchlight</p>
<h1 style="margin:0 0 16px;font-family:Georgia,serif;font-size:20px;font-weight:500;color:#1C1712;">${heading}</h1>
${body}${cta}${note}
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

export function sendPasswordResetEmail(user, token, ttlMinutes) {
  // A fragment, not a query string. The part after # never leaves the
  // browser: it is not sent to Cloudflare, not written to any access log,
  // and not carried in a Referer header to the font CDN the page loads.
  const link = `${appUrl()}/reset-password#${token}`;
  const name = firstName(user.name);

  const text = [
    `Hi ${name},`,
    '',
    'Someone asked to reset the password for your Porchlight account. If it was you, open this link to choose a new one:',
    '',
    link,
    '',
    `It works once, for the next ${ttlMinutes} minutes.`,
    '',
    "If it wasn't you, you can ignore this email. Your password hasn't changed."
  ].join('\n');

  const html = layout({
    heading: 'Reset your password',
    paragraphs: [
      `Hi ${escapeHtml(name)},`,
      'Someone asked to reset the password for your Porchlight account. If it was you, choose a new one here:'
    ],
    button: { href: link, label: 'Choose a new password' },
    footnote: `This link works once, for the next ${ttlMinutes} minutes. If it wasn't you, you can ignore this email. Your password hasn't changed.`
  });

  return sendMail({ to: user.email, subject: 'Reset your Porchlight password', text, html });
}

export function sendPasswordChangedEmail(user) {
  const name = firstName(user.name);
  const resetLink = `${appUrl()}/forgot-password`;

  const text = [
    `Hi ${name},`,
    '',
    'The password for your Porchlight account was just changed, and every device that was signed in has been signed out.',
    '',
    `If that was you, there's nothing else to do. If it wasn't, reset it now: ${resetLink}`
  ].join('\n');

  const html = layout({
    heading: 'Your password was changed',
    paragraphs: [
      `Hi ${escapeHtml(name)},`,
      'The password for your Porchlight account was just changed, and every device that was signed in has been signed out.',
      "If that was you, there's nothing else to do."
    ],
    footnote: `If it wasn't you, <a href="${escapeHtml(resetLink)}" style="color:#A9762F;">reset your password now</a>.`
  });

  return sendMail({ to: user.email, subject: 'Your Porchlight password was changed', text, html });
}
