// server.js — API LoyerPay (hasnemtech) — base de données Turso (persistante, gratuite)
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
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const requireAuth = async (req, res, next) => {
  try {
    const gestionnaireId = req.headers['x-gestionnaire-id'] || req.query.gestionnaireId;
    if (!gestionnaireId) return res.status(401).json({ error: 'gestionnaire_id manquant' });
    const g = await db.get('SELECT * FROM gestionnaires WHERE id = ?', [gestionnaireId]);
    if (!g) return res.status(401).json({ error: 'gestionnaire introuvable' });
    const check = verifyLicense(g.device_id, g.license_code);
    if (!check.valid) return res.status(403).json({ error: 'licence_invalide', reason: check.reason });
    req.gestionnaire = g;
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'erreur_auth' });
  }
};

// ---------- LICENCE ----------
app.post('/api/license/generate', (req, res) => {
  const { deviceId, quotaLocataires, dureeJours } = req.body;
  const expiry = new Date(Date.now() + dureeJours * 86400000).toISOString().slice(0, 10);
  const code = generateLicense(deviceId, quotaLocataires, expiry);
  res.json({ licenseCode: code, expiry });
});

app.post('/api/gestionnaires', async (req, res) => {
  try {
    const { nom, telephone, email, deviceId, licenseCode } = req.body;
    const check = verifyLicense(deviceId, licenseCode);
    if (!check.valid) return res.status(403).json({ error: check.reason });

    const id = uuid();
    await db.run(
      `INSERT INTO gestionnaires (id, nom, telephone, email, device_id, license_code, license_expiry, quota_locataires)
       VALUES (?,?,?,?,?,?,?,?)`,
      [id, nom, telephone, email, deviceId, licenseCode, check.expiryDate.toISOString(), check.quota]
    );
    res.json({ id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'erreur_creation_gestionnaire' });
  }
});

// Enregistre le tampon/signature du gestionnaire (stocké en base64 dans Turso, donc persistant)
app.put('/api/gestionnaires/signature', requireAuth, async (req, res) => {
  try {
    const { signature_data } = req.body; // data URL complète, ex: "data:image/png;base64,iVBORw0..."
    if (signature_data && !/^data:image\/(png|jpe?g);base64,/.test(signature_data)) {
      return res.status(400).json({ error: 'format_image_invalide' });
    }
    await db.run('UPDATE gestionnaires SET signature_data = ? WHERE id = ?', [signature_data || null, req.gestionnaire.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'erreur_enregistrement_signature' });
  }
});

app.put('/api/gestionnaires/numeros-marchand', requireAuth, async (req, res) => {
  try {
    const { numero_marchand_flooz, numero_marchand_mixx } = req.body;
    await db.run(
      'UPDATE gestionnaires SET numero_marchand_flooz = ?, numero_marchand_mixx = ? WHERE id = ?',
      [numero_marchand_flooz || null, numero_marchand_mixx || null, req.gestionnaire.id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'erreur_mise_a_jour' });
  }
});

// ---------- LOCATAIRES ----------
app.post('/api/locataires', requireAuth, async (req, res) => {
  try {
    const nbActuelRow = await db.get(
      'SELECT COUNT(*) as c FROM locataires WHERE gestionnaire_id = ? AND actif = 1',
      [req.gestionnaire.id]
    );
    const nbActuel = nbActuelRow.c;
    if (nbActuel >= req.gestionnaire.quota_locataires) {
      return res.status(403).json({ error: 'quota_locataires_atteint', quota: req.gestionnaire.quota_locataires });
    }
    const { nom, telephone, montant_loyer, immeuble_id, jour_echeance } = req.body;
    const id = uuid();
    await db.run(
      `INSERT INTO locataires (id, gestionnaire_id, immeuble_id, nom, telephone, montant_loyer, jour_echeance)
       VALUES (?,?,?,?,?,?,?)`,
      [id, req.gestionnaire.id, immeuble_id || null, nom, telephone, montant_loyer, jour_echeance || 5]
    );
    res.json({ id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'erreur_ajout_locataire' });
  }
});

app.get('/api/locataires', requireAuth, async (req, res) => {
  try {
    const rows = await db.all('SELECT * FROM locataires WHERE gestionnaire_id = ? AND actif = 1', [req.gestionnaire.id]);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'erreur_lecture_locataires' });
  }
});

app.get('/api/locataires/:id/historique', requireAuth, async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT * FROM paiements WHERE locataire_id = ? AND gestionnaire_id = ? ORDER BY mois_concerne DESC LIMIT 12`,
      [req.params.id, req.gestionnaire.id]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'erreur_lecture_historique' });
  }
});

// ---------- PAIEMENTS ----------
app.post('/api/paiements/demander', requireAuth, async (req, res) => {
  try {
    const { locataire_id, mois_concerne, mode } = req.body;
    const locataire = await db.get('SELECT * FROM locataires WHERE id = ? AND gestionnaire_id = ?', [locataire_id, req.gestionnaire.id]);
    if (!locataire) return res.status(404).json({ error: 'locataire_introuvable' });

    const paiementId = uuid();
    await db.run(
      `INSERT INTO paiements (id, gestionnaire_id, locataire_id, montant, mois_concerne, mode) VALUES (?,?,?,?,?,?)`,
      [paiementId, req.gestionnaire.id, locataire_id, locataire.montant_loyer, mois_concerne, mode || 'fedapay']
    );

    if (mode === 'manuel') {
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
          message: `${locataire.nom}, merci d'envoyer ${locataire.montant_loyer} FCFA `
            + `(loyer ${mois_concerne}) au ${req.gestionnaire.numero_marchand_flooz || req.gestionnaire.numero_marchand_mixx}. `
            + `Envoyez-nous ensuite la référence reçue par SMS pour confirmation.`
        }
      });
    }

    const { transactionId, paymentUrl } = await creerTransaction({
      montant: locataire.montant_loyer,
      description: `Loyer ${mois_concerne} - ${locataire.nom}`,
      locataire,
      callbackUrl: `${process.env.PUBLIC_URL}/api/webhook/fedapay`,
      customData: { paiement_id: paiementId }
    });

    await db.run('UPDATE paiements SET fedapay_transaction_id = ? WHERE id = ?', [transactionId, paiementId]);

    res.json({ paiementId, mode: 'fedapay', paymentUrl });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: 'erreur_creation_paiement' });
  }
});

app.post('/api/paiements/:id/confirmer-manuel', requireAuth, async (req, res) => {
  try {
    const { reference_saisie, moyen_paiement } = req.body;
    const paiement = await db.get('SELECT * FROM paiements WHERE id = ? AND gestionnaire_id = ?', [req.params.id, req.gestionnaire.id]);
    if (!paiement) return res.status(404).json({ error: 'paiement_introuvable' });
    if (paiement.statut === 'confirme') return res.status(400).json({ error: 'deja_confirme' });
    if (!reference_saisie) return res.status(400).json({ error: 'reference_requise' });

    await db.run(
      `UPDATE paiements SET statut='confirme', mode='manuel', moyen_paiement=?, reference_saisie=?,
       confirme_par=?, confirmed_at=datetime('now') WHERE id = ?`,
      [moyen_paiement || null, reference_saisie, req.gestionnaire.id, req.params.id]
    );

    const paiementMaj = await db.get('SELECT * FROM paiements WHERE id = ?', [req.params.id]);
    const locataire = await db.get('SELECT * FROM locataires WHERE id = ?', [paiementMaj.locataire_id]);
    const gestionnaire = req.gestionnaire;

    const recuPath = await genererRecu({ gestionnaire, locataire, paiement: paiementMaj, outputDir: RECUS_DIR });
    await db.run('UPDATE paiements SET recu_path = ? WHERE id = ?', [recuPath, req.params.id]);

    res.json({ ok: true, recuGenere: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'erreur_confirmation' });
  }
});

app.post('/api/paiements/:id/regenerer-recu', requireAuth, async (req, res) => {
  try {
    const paiement = await db.get('SELECT * FROM paiements WHERE id = ? AND gestionnaire_id = ?', [req.params.id, req.gestionnaire.id]);
    if (!paiement) return res.status(404).json({ error: 'paiement_introuvable' });
    if (paiement.statut !== 'confirme') return res.status(400).json({ error: 'paiement_non_confirme' });

    const locataire = await db.get('SELECT * FROM locataires WHERE id = ?', [paiement.locataire_id]);
    const recuPath = await genererRecu({ gestionnaire: req.gestionnaire, locataire, paiement, outputDir: RECUS_DIR });
    await db.run('UPDATE paiements SET recu_path = ? WHERE id = ?', [recuPath, req.params.id]);

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'erreur_regeneration' });
  }
});

// Webhook FedaPay
app.post('/api/webhook/fedapay', async (req, res) => {
  try {
    const signature = req.headers['x-fedapay-signature'];
    if (!verifierSignatureWebhook(req.rawBody, signature)) {
      return res.status(401).json({ error: 'signature_invalide' });
    }

    const event = req.body;
    if (event.name !== 'transaction.approved') return res.json({ ok: true });

    const transaction = event.entity;
    const paiementId = transaction.custom_metadata?.paiement_id;
    if (!paiementId) return res.status(400).json({ error: 'metadata_manquante' });

    const paiement = await db.get('SELECT * FROM paiements WHERE id = ?', [paiementId]);
    if (!paiement) return res.status(404).json({ error: 'paiement_introuvable' });

    const locataire = await db.get('SELECT * FROM locataires WHERE id = ?', [paiement.locataire_id]);
    const gestionnaire = await db.get('SELECT * FROM gestionnaires WHERE id = ?', [paiement.gestionnaire_id]);

    await db.run(
      `UPDATE paiements SET statut='confirme', moyen_paiement=?, fedapay_reference=?, confirmed_at=datetime('now') WHERE id = ?`,
      [transaction.mode || 'mobile_money', transaction.reference || transaction.id, paiementId]
    );

    const paiementMaj = await db.get('SELECT * FROM paiements WHERE id = ?', [paiementId]);
    const recuPath = await genererRecu({ gestionnaire, locataire, paiement: paiementMaj, outputDir: RECUS_DIR });
    await db.run('UPDATE paiements SET recu_path = ? WHERE id = ?', [recuPath, paiementId]);

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'erreur_webhook' });
  }
});

app.get('/api/paiements/:id/recu', requireAuth, async (req, res) => {
  try {
    const paiement = await db.get('SELECT * FROM paiements WHERE id = ? AND gestionnaire_id = ?', [req.params.id, req.gestionnaire.id]);
    if (!paiement || paiement.statut !== 'confirme') {
      return res.status(404).json({ error: 'recu_non_disponible' });
    }

    // Régénéré à chaque téléchargement : garantit que la signature/tampon la plus récente
    // est toujours incluse, et évite toute dépendance à un fichier stocké sur disque.
    const locataire = await db.get('SELECT * FROM locataires WHERE id = ?', [paiement.locataire_id]);
    const recuPath = await genererRecu({ gestionnaire: req.gestionnaire, locataire, paiement, outputDir: RECUS_DIR });
    await db.run('UPDATE paiements SET recu_path = ? WHERE id = ?', [recuPath, req.params.id]);
    res.download(recuPath);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'erreur_telechargement' });
  }
});

const PORT = process.env.PORT || 4000;
db.initSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`LoyerPay backend démarré sur le port ${PORT}`));
  })
  .catch((e) => {
    console.error('Erreur initialisation base de données Turso :', e);
    process.exit(1);
  });
