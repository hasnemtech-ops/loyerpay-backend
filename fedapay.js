// fedapay.js — Création de paiement (Flooz/T-Money via FedaPay) + vérification webhook
const axios = require('axios');
const crypto = require('crypto');

const FEDAPAY_BASE_URL = process.env.FEDAPAY_ENV === 'live'
  ? 'https://api.fedapay.com/v1'
  : 'https://sandbox-api.fedapay.com/v1';

const FEDAPAY_SECRET_KEY = process.env.FEDAPAY_SECRET_KEY;
const FEDAPAY_WEBHOOK_SECRET = process.env.FEDAPAY_WEBHOOK_SECRET;

const client = axios.create({
  baseURL: FEDAPAY_BASE_URL,
  headers: {
    Authorization: `Bearer ${FEDAPAY_SECRET_KEY}`,
    'Content-Type': 'application/json'
  }
});

// Crée une transaction FedaPay pour un locataire et renvoie l'URL de paiement à lui envoyer (WhatsApp/SMS)
async function creerTransaction({ montant, description, locataire, callbackUrl, customData }) {
  const { data } = await client.post('/transactions', {
    description,
    amount: montant,
    currency: { iso: 'XOF' },
    customer: {
      firstname: locataire.nom.split(' ')[0] || locataire.nom,
      lastname: locataire.nom.split(' ').slice(1).join(' ') || '-',
      phone_number: { number: locataire.telephone, country: 'TG' }
    },
    callback_url: callbackUrl,
    custom_metadata: customData // { paiement_id, locataire_id, mois_concerne }
  });

  const transaction = data['v1/transaction'];

  // Génère le lien/token de paiement (checkout FedaPay)
  const tokenResp = await client.post(`/transactions/${transaction.id}/token`);
  const paymentUrl = tokenResp.data.url;

  return { transactionId: transaction.id, paymentUrl };
}

// Vérifie la signature du webhook FedaPay pour éviter les faux appels
function verifierSignatureWebhook(rawBody, signatureHeader) {
  if (!FEDAPAY_WEBHOOK_SECRET) return true; // à activer dès que le secret est configuré côté dashboard FedaPay
  const expected = crypto
    .createHmac('sha256', FEDAPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return expected === signatureHeader;
}

module.exports = { creerTransaction, verifierSignatureWebhook };
