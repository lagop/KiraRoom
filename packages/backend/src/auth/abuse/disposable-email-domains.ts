/**
 * Disposable ("temporary inbox") email domains, refused at signup.
 *
 * A vendored, curated list rather than a dependency: the npm lists (e.g.
 * `disposable-email-domains`) carry tens of thousands of entries, are
 * refreshed irregularly and add a supply-chain dependency to the signup
 * path, while the bulk of throwaway signups come from a few dozen well-known
 * services and their alias domains. Those are below. Subdomains count too
 * (anything under mailinator.com is mailinator).
 *
 * Keep it sorted and lower-case. To add one, put the bare domain here; the
 * spec checks the format. Sources: the public lists of 10minutemail,
 * Guerrilla Mail, Mailinator, YOPmail, temp-mail, 1secmail, Moakt and
 * Fake Mail Generator alias domains.
 */
export const DISPOSABLE_EMAIL_DOMAINS: readonly string[] = [
  "0-mail.com",
  "10minemail.com",
  "10minutemail.co.uk",
  "10minutemail.com",
  "10minutemail.net",
  "1secmail.com",
  "1secmail.net",
  "1secmail.org",
  "20minutemail.com",
  "anonbox.net",
  "armyspy.com",
  "binkmail.com",
  "bobmail.info",
  "burnermail.io",
  "byom.de",
  "chammy.info",
  "cool.fr.nf",
  "correotemporal.org",
  "courriel.fr.nf",
  "crazymailing.com",
  "cuvox.de",
  "dayrep.com",
  "devnullmail.com",
  "disbox.net",
  "discard.email",
  "discardmail.com",
  "discardmail.de",
  "dispostable.com",
  "dpptd.com",
  "einrot.com",
  "emailfake.com",
  "emailondeck.com",
  "emailtemporario.com.br",
  "emltmp.com",
  "esiix.com",
  "fakeinbox.com",
  "fakemail.net",
  "fakemailgenerator.com",
  "fexbox.org",
  "fexpost.com",
  "fleckens.hu",
  "generator.email",
  "getairmail.com",
  "getnada.com",
  "grr.la",
  "guerrillamail.biz",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.info",
  "guerrillamail.net",
  "guerrillamail.org",
  "guerrillamailblock.com",
  "gustr.com",
  "harakirimail.com",
  "inboxbear.com",
  "inboxkitten.com",
  "incognitomail.com",
  "jetable.fr.nf",
  "jourrapide.com",
  "kasmail.com",
  "kzccv.com",
  "letthemeatspam.com",
  "mail-temporaire.fr",
  "mail.tm",
  "mail7.io",
  "mailcatch.com",
  "maildrop.cc",
  "mailexpire.com",
  "mailforspam.com",
  "mailinater.com",
  "mailinator.com",
  "mailinator.net",
  "mailinator2.com",
  "mailmoat.com",
  "mailnesia.com",
  "mailnull.com",
  "mailpoof.com",
  "mailsac.com",
  "mailto.plus",
  "mega.zik.dj",
  "mintemail.com",
  "minuteinbox.com",
  "moakt.cc",
  "moakt.com",
  "mohmal.com",
  "moncourrier.fr.nf",
  "monemail.fr.nf",
  "monmail.fr.nf",
  "mvrht.com",
  "mytemp.email",
  "nada.email",
  "nomail.xl.cx",
  "nospam.ze.tc",
  "notmailinator.com",
  "pokemail.net",
  "qiott.com",
  "rhyta.com",
  "safetymail.info",
  "sharklasers.com",
  "sogetthis.com",
  "spam4.me",
  "spambog.com",
  "spambog.de",
  "spambox.us",
  "spamdecoy.net",
  "spamex.com",
  "spamfree24.org",
  "spamgourmet.com",
  "spamherelots.com",
  "speed.1s.fr",
  "superrito.com",
  "suremail.info",
  "teleworm.us",
  "temp-mail.io",
  "temp-mail.org",
  "tempail.com",
  "tempinbox.com",
  "tempmail.com",
  "tempmail.dev",
  "tempmail.net",
  "tempmail.plus",
  "tempmailaddress.com",
  "tempmailo.com",
  "tempr.email",
  "thisisnotmyrealemail.com",
  "throwawaymail.com",
  "tmails.net",
  "tmpbox.net",
  "tmpeml.com",
  "tmpmail.net",
  "tmpmail.org",
  "tradermail.info",
  "trash-mail.com",
  "trashmail.com",
  "trashmail.de",
  "trashmail.io",
  "trashmail.me",
  "trashmail.net",
  "trbvm.com",
  "veryrealemail.com",
  "vjuum.com",
  "wegwerfemail.de",
  "wegwerfmail.de",
  "wegwerfmail.net",
  "wwjmp.com",
  "xojxe.com",
  "yoggm.com",
  "yopmail.com",
  "yopmail.fr",
  "yopmail.net",
  "zippymail.info",
];

const DISPOSABLE = new Set(DISPOSABLE_EMAIL_DOMAINS);

/** The domain part of an address, lower-cased; "" when there is none. */
export function emailDomain(email: string): string {
  const at = (email ?? "").lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).trim().toLowerCase().replace(/\.+$/, "");
}

/** Whether the address is at a disposable-inbox service (or a subdomain of one). */
export function isDisposableEmail(email: string): boolean {
  const labels = emailDomain(email).split(".").filter(Boolean);
  for (let i = 0; i + 1 < labels.length; i++) {
    if (DISPOSABLE.has(labels.slice(i).join("."))) return true;
  }
  return false;
}

/**
 * The big consumer providers: many salons sign up with them, so their
 * per-domain signup allowance is high. Any other domain is somebody's own
 * (a salon's or a spammer's) and gets a low one.
 */
export const COMMON_EMAIL_PROVIDERS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "hotmail.com", "hotmail.es", "outlook.com", "outlook.es",
  "live.com", "live.es", "msn.com", "yahoo.com", "yahoo.es", "ymail.com", "icloud.com",
  "me.com", "mac.com", "aol.com", "gmx.com", "gmx.es", "proton.me", "protonmail.com",
  "telefonica.net", "movistar.es", "orange.es", "vodafone.es",
]);
