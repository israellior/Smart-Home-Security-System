import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

/**
 * Account email - password resets and "your password was changed" -
 * sent through Amazon SES.
 *
 * There are no keys here. In production the SDK picks up the instance
 * role's short-lived credentials (see infra/terraform/iam.tf), the same
 * way everything else on that box authenticates to AWS. Locally it uses
 * whatever `aws login` left behind, if you want real mail in development.
 *
 * EMAIL_FROM is what switches it on. Without it nothing is sent, and in
 * development the message is printed instead, so a reset link can still
 * be followed from the terminal. Never in production: there the console
 * is CloudWatch, and a reset link in the logs is a way into the account
 * for anyone who can read them.
 */

const { EMAIL_FROM } = process.env;

export const mailConfigured = Boolean(EMAIL_FROM);

const client = mailConfigured
  ? new SESv2Client({ region: process.env.AWS_REGION || 'eu-west-1' })
  : null;

/**
 * @param {object} message  { to, subject, text, html }
 * @returns {Promise<boolean>} whether it was handed to SES
 */
export async function sendMail({ to, subject, text, html }) {
  if (!client) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[mail] EMAIL_FROM not set; would send to ${to}:\n  ${subject}\n\n${text}\n`);
    } else {
      console.warn(`[mail] EMAIL_FROM not set; dropped "${subject}"`);
    }
    return false;
  }

  await client.send(
    new SendEmailCommand({
      FromEmailAddress: EMAIL_FROM,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: subject, Charset: 'UTF-8' },
          Body: {
            Text: { Data: text, Charset: 'UTF-8' },
            ...(html && { Html: { Data: html, Charset: 'UTF-8' } })
          }
        }
      }
    })
  );
  return true;
}
