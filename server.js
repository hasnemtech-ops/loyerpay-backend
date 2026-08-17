// server.js — API LoyerPay (hasnemtech)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuid } = require('uuid');
const fs = require('fs');
const path = require('path');

const db = require('./db');
const { generateLicense, verifyLicense } = require('./license');
const { creerTransaction, verifierSignatureWebhook } = require('./fedapay');
const { genererRecu } = require('./receipt');

const app = express();
const RECUS_DIR = path.join(__dirname, 'recus');
if (!fs.existsSync(RECUS_DIR)) fs.mkdirSync(RECUS_DIR);

app.use(cors());
// on garde le rawBody pour le webhook FedaPay (vérification de signature)
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const requireAuth = (req, res, next) => {
  const gestionnaireId = req.headers['x-gestionnaire-id'];
  if (!gestionnaireId) return res.status(401).json({ error: 'gestionnaire_id manquant' });
  const g = db.prepare('SELECT * FROM gestionnaires WHERE id = ?').get(gestionnaireId);
  if (!g) return res.status(401).json({ error: 'gestionnaire introuvable' });
  const check = verifyLicense(g.device_id, g.license_code);
  if (!check.valid) return res.status(403).json({ error: 'licence_invalide', reason: check.reason });
  req.gestionnaire = g;
  next();
};

// ---------- LICENCE ----------
app.post('/api/license/generate', (req, res) => {
  // route admin (hasnemtech) — protéger avec une clé admin en prod
  const { deviceId, quotaLocataires, dureeJours } = req.body;
  const expiry = new Date(Date.now() + dureeJours * 86400000).toISOString().slice(0, 10);
  const code = generateLicense(deviceId, quotaLocataires, expiry);
  res.json({ licenseCode: code, expiry });
});

app.post('/api/gestionnaires', (req, res) => {
  const { nom, telephone, email, deviceId, licenseCode } = req.body;
  const check = verifyLicense(deviceId, licenseCode);
  if (!check.valid) return res.status(403).json({ error: check.reason });

  const id = uuid();
  db.prepare(`INSERT INTO gestionnaires (id, nom, telephone, email, device_id, license_code, license_expiry, quota_locataires)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, nom, telephone, email, deviceId, licenseCode, check.expiryDate.toISOString(), check.quota);
  res.json({ id });
});

app.put('/api/gestionnaires/numeros-marchand', requireAuth, (req, res) => {
  const { numero_marchand_flooz, numero_marchand_mixx } = req.body;
  db.prepare('UPDATE gestionnaires SET numero_marchand_flooz = ?, numero_marchand_mixx = ? WHERE id = ?')
    .run(numero_marchand_flooz || null, numero_marchand_mixx || null, req.gestionnaire.id);
  res.json({ ok: true });
});

// ---------- LOCATAIRES ----------
app.post('/api/locataires', requireAuth, (req, res) => {
  const nbActuel = db.prepare('SELECT COUNT(*) c FROM locataires WHERE gestionnaire_id = ? AND actif = 1')
    .get(req.gestionnaire.id).c;
  if (nbActuel >= req.gestionnaire.quota_locataires) {
    return res.status(403).json({ error: 'quota_locataires_atteint', quota: req.gestionnaire.quota_locataires });
  }
  const { nom, telephone, montant_loyer, immeuble_id, jour_echeance } = req.body;
  const id = uuid();
  db.prepare(`INSERT INTO locataires (id, gestionnaire_id, immeuble_id, nom, telephone, montant_loyer, jour_echeance)
              VALUES (?,?,?,?,?,?,?)`)
    .run(id, req.gestionnaire.id, immeuble_id || null, nom, telephone, montant_loyer, jour_echeance || 5);
  res.json({ id });
});

app.get('/api/locataires', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM locataires WHERE gestionnaire_id = ? AND actif = 1').all(req.gestionnaire.id);
  res.json(rows);
});

// Historique 12 mois d'un locataire
app.get('/api/locataires/:id/historique', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM paiements
    WHERE locataire_id = ? AND gestionnaire_id = ?
    ORDER BY mois_concerne DESC LIMIT 12
  `).all(req.params.id, req.gestionnaire.id);
  res.json(rows);
});

// ---------- PAIEMENTS ----------
// Crée un lien de paiement FedaPay pour un locataire/mois donné
app.post('/api/paiements/demander', requireAuth, async (req, res) => {
  try {
    const { locataire_id, mois_concerne, mode } = req.body; // mode: 'fedapay' (défaut) | 'manuel'
    const locataire = db.prepare('SELECT * FROM locataires WHERE id = ? AND gestionnaire_id = ?')
      .get(locataire_id, req.gestionnaire.id);
    if (!locataire) return res.status(404).json({ error: 'locataire_introuvable' });

    const paiementId = uuid();
    db.prepare(`INSERT INTO paiements (id, gestionnaire_id, locataire_id, montant, mois_concerne, mode)
                VALUES (?,?,?,?,?,?)`)
      .run(paiementId, req.gestionnaire.id, locataire_id, locataire.montant_loyer, mois_concerne, mode || 'fedapay');

    if (mode === 'manuel') {
      // 0% commission : le locataire paie directement sur le numéro marchand du gestionnaire.
      // Aucun appel FedaPay — la confirmation se fera via /api/paiements/:id/confirmer-manuel
      if (!req.gestionnaire.numero_marchand_flooz && !req.gestionnaire.numero_marchand_mixx) {
        return res.status(400).json({ error: 'numeros_marchand_non_configures' });
      }
      return res.json({
        paiementId,
        mode: 'manuel',
        instructions: {
          montant: locataire.montant_loyer,
          numero_marchand_flooz: req.gestionnaire.numero_marchand_flooz,
          numero_marchand_mixx: req.gestionnaire.numero_marchand_mixx,
          message: `${locataire.nom}, merci d'envoyer ${locataire.montant_loyer.toLocaleString('fr-FR')} FCFA `
            + `(loyer ${mois_concerne}) au ${req.gestionnaire.numero_marchand_flooz || req.gestionnaire.numero_marchand_mixx}. `
            + `Envoyez-nous ensuite la référence reçue par SMS pour confirmation.`
        }
      });
    }

    // mode par défaut : FedaPay (avec commission, entièrement automatique)
    const { transactionId, paymentUrl } = await creerTransaction({
      montant: locataire.montant_loyer,
      description: `Loyer ${mois_concerne} - ${locataire.nom}`,
      locataire,
      callbackUrl: `${process.env.PUBLIC_URL}/api/webhook/fedapay`,
      customData: { paiement_id: paiementId }
    });

    db.prepare('UPDATE paiements SET fedapay_transaction_id = ? WHERE id = ?').run(transactionId, paiementId);

    res.json({ paiementId, mode: 'fedapay', paymentUrl }); // à envoyer au locataire par WhatsApp/SMS
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: 'erreur_creation_paiement' });
  }
});

// Confirmation manuelle (mode 0% commission) — le gestionnaire saisit la référence reçue par SMS
app.post('/api/paiements/:id/confirmer-manuel', requireAuth, async (req, res) => {
  try {
    const { reference_saisie, moyen_paiement } = req.body; // moyen_paiement: 'flooz' | 'mixx'
    const paiement = db.prepare('SELECT * FROM paiements WHERE id = ? AND gestionnaire_id = ?')
      .get(req.params.id, req.gestionnaire.id);
    if (!paiement) return res.status(404).json({ error: 'paiement_introuvable' });
    if (paiement.statut === 'confirme') return res.status(400).json({ error: 'deja_confirme' });
    if (!reference_saisie) return res.status(400).json({ error: 'reference_requise' });

    db.prepare(`UPDATE paiements SET statut='confirme', mode='manuel', moyen_paiement=?, reference_saisie=?,
                confirme_par=?, confirmed_at=datetime('now') WHERE id = ?`)
      .run(moyen_paiement || null, reference_saisie, req.gestionnaire.id, req.params.id);

    const paiementMaj = db.prepare('SELECT * FROM paiements WHERE id = ?').get(req.params.id);
    const locataire = db.prepare('SELECT * FROM locataires WHERE id = ?').get(paiementMaj.locataire_id);
    const gestionnaire = req.gestionnaire;

    const recuPath = await genererRecu({ gestionnaire, locataire, paiement: paiementMaj, outputDir: RECUS_DIR });
    db.prepare('UPDATE paiements SET recu_path = ? WHERE id = ?').run(recuPath, req.params.id);

    res.json({ ok: true, recuGenere: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'erreur_confirmation' });
  }
});

// Webhook FedaPay — appelé automatiquement à la confirmation du paiement
app.post('/api/webhook/fedapay', async (req, res) => {
  const signature = req.headers['x-fedapay-signature'];
  if (!verifierSignatureWebhook(req.rawBody, signature)) {
    return res.status(401).json({ error: 'signature_invalide' });
  }

  const event = req.body;
  if (event.name !== 'transaction.approved') return res.json({ ok: true }); // on ignore le reste

  const transaction = event.entity;
  const paiementId = transaction.custom_metadata?.paiement_id;
  if (!paiementId) return res.status(400).json({ error: 'metadata_manquante' });

  const paiement = db.prepare('SELECT * FROM paiements WHERE id = ?').get(paiementId);
  if (!paiement) return res.status(404).json({ error: 'paiement_introuvable' });

  const locataire = db.prepare('SELECT * FROM locataires WHERE id = ?').get(paiement.locataire_id);
  const gestionnaire = db.prepare('SELECT * FROM gestionnaires WHERE id = ?').get(paiement.gestionnaire_id);

  db.prepare(`UPDATE paiements SET statut='confirme', moyen_paiement=?, fedapay_reference=?, confirmed_at=datetime('now')
              WHERE id = ?`)
    .run(transaction.mode || 'mobile_money', transaction.reference || transaction.id, paiementId);

  const paiementMaj = db.prepare('SELECT * FROM paiements WHERE id = ?').get(paiementId);
  const recuPath = await genererRecu({ gestionnaire, locataire, paiement: paiementMaj, outputDir: RECUS_DIR });
  db.prepare('UPDATE paiements SET recu_path = ? WHERE id = ?').run(recuPath, paiementId);

  // TODO: envoi automatique du reçu par WhatsApp au locataire (même approche que l'app de facturation électricité)

  res.json({ ok: true });
});

// Régénère le reçu d'un paiement déjà confirmé (rattrapage si la génération avait échoué)
app.post('/api/paiements/:id/regenerer-recu', requireAuth, async (req, res) => {
  try {
    const paiement = db.prepare('SELECT * FROM paiements WHERE id = ? AND gestionnaire_id = ?')
      .get(req.params.id, req.gestionnaire.id);
    if (!paiement) return res.status(404).json({ error: 'paiement_introuvable' });
    if (paiement.statut !== 'confirme') return res.status(400).json({ error: 'paiement_non_confirme' });

    const locataire = db.prepare('SELECT * FROM locataires WHERE id = ?').get(paiement.locataire_id);
    const recuPath = await genererRecu({ gestionnaire: req.gestionnaire, locataire, paiement, outputDir: RECUS_DIR });
    db.prepare('UPDATE paiements SET recu_path = ? WHERE id = ?').run(recuPath, req.params.id);

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'erreur_regeneration' });
  }
});

// Téléchargement du reçu
app.get('/api/paiements/:id/recu', requireAuth, (req, res) => {
  const paiement = db.prepare('SELECT * FROM paiements WHERE id = ? AND gestionnaire_id = ?')
    .get(req.params.id, req.gestionnaire.id);
  if (!paiement?.recu_path || !fs.existsSync(paiement.recu_path)) {
    return res.status(404).json({ error: 'recu_non_disponible' });
  }
  res.download(paiement.recu_path);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`LoyerPay backend démarré sur le port ${PORT}`));
