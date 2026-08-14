// license.js — Licence device-locked, quota = nb max de locataires
// Même principe que Devis Pro : hash FNV-1a(deviceId + secret + quota + expiry)
const SECRET_KEY = process.env.LICENSE_SECRET || 'CHANGE_ME_hasnemtech_secret';

function fnv1a(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// Génère un code licence : QUOTA-EXPIRY-HASH (ex: 0050-20270806-a1b2c3d4)
function generateLicense(deviceId, quotaLocataires, expiryDate /* 'YYYY-MM-DD' */) {
  const quotaStr = String(quotaLocataires).padStart(4, '0');
  const expiryStr = expiryDate.replace(/-/g, '');
  const raw = `${deviceId}|${SECRET_KEY}|${quotaStr}|${expiryStr}`;
  const hash = fnv1a(raw);
  return `${quotaStr}-${expiryStr}-${hash}`.toUpperCase();
}

function verifyLicense(deviceId, licenseCode) {
  if (!licenseCode || !licenseCode.includes('-')) return { valid: false, reason: 'format_invalide' };
  const [quotaStr, expiryStr, providedHash] = licenseCode.split('-');
  if (!quotaStr || !expiryStr || !providedHash) return { valid: false, reason: 'format_invalide' };

  const raw = `${deviceId}|${SECRET_KEY}|${quotaStr}|${expiryStr}`;
  const expectedHash = fnv1a(raw).toUpperCase();

  if (providedHash.toUpperCase() !== expectedHash) {
    return { valid: false, reason: 'licence_invalide_pour_cet_appareil' };
  }

  const expiryDate = new Date(
    `${expiryStr.slice(0, 4)}-${expiryStr.slice(4, 6)}-${expiryStr.slice(6, 8)}`
  );
  if (expiryDate < new Date()) {
    return { valid: false, reason: 'licence_expiree', expiryDate };
  }

  return { valid: true, quota: parseInt(quotaStr, 10), expiryDate };
}

module.exports = { generateLicense, verifyLicense, fnv1a };
