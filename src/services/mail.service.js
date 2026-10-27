// Outgoing email over SMTP (settings in env.smtp). Like push notifications, email never fails the caller: a send that
// can't be made is logged and skipped. Each email carries a key (event + recipient) and is sent at most once.
import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { EmailLog } from '../models/index.js';

let transport = null;

// under `node --test` only a transport a test sets is used, so the suite never emails anyone through real SMTP settings
const underTest = Boolean(process.env.NODE_TEST_CONTEXT);
export const isMailConfigured = () => Boolean(transport || (!underTest && env.smtp.host && env.smtp.from));

function transporter() {
  transport ||= nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.secure,
    ...(env.smtp.user && { auth: { user: env.smtp.user, pass: env.smtp.pass } }),
  });
  return transport;
}

/** Tests replace the SMTP connection (e.g. with nodemailer's JSON transport); `null` goes back to the settings. */
export function setMailTransport(t) {
  transport = t;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmail = (v) => EMAIL.test(String(v || '').trim());

/** "Acme Solar" <notifications@…>: the company's name, the platform's sending address. */
const fromAs = (name) => {
  const address = env.smtp.from || 'notifications@localhost';
  return name ? { name: String(name).replace(/["<>\r\n]/g, '').slice(0, 80), address } : address;
};

/**
 * Sends one email unless one with the same `key` was sent before. Returns true when it was sent now.
 * { key, to, subject, html, text, fromName, replyTo, companyId }
 */
export async function sendMailOnce({ key, to, subject, html, text, fromName, replyTo, companyId = null }) {
  if (!isMailConfigured() || !isEmail(to)) return false;
  await EmailLog.init(); // the unique key index must exist before the first email, or a repeat could slip through
  try {
    await EmailLog.create({ key: String(key).slice(0, 400), company: companyId, to, subject: String(subject).slice(0, 300) });
  } catch (e) {
    if (e?.code === 11000) return false; // already sent for this event
    throw e;
  }
  try {
    await transporter().sendMail({ from: fromAs(fromName), to, subject, html, text, ...(isEmail(replyTo) && { replyTo }) });
    return true;
  } catch (e) {
    await EmailLog.deleteOne({ key: String(key).slice(0, 400) }).catch(() => {}); // not sent: let a later attempt try again
    console.error(`[mail] could not send "${subject}" to ${to}: ${e.message}`);
    return false;
  }
}
