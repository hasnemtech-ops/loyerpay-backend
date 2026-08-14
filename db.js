// db.js — Base SQLite multi-tenant (un gestionnaire = plusieurs immeubles = plusieurs locataires)
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'loyerpay.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS gestionnaires (
  id TEXT PRIMARY KEY,
  nom TEXT NOT NULL,
  telephone TEXT,
  email TEXT,
  device_id TEXT,              -- verrouillage licence sur l'appareil
  license_code TEXT,
  license_expiry TEXT,         -- date ISO
  quota_locataires INTEGER DEFAULT 10,
  signature_path TEXT,         -- tampon/signature réutilisé sur les reçus
  numero_marchand_flooz TEXT,  -- numéro Flooz du gestionnaire (mode manuel, 0% commission)
  numero_marchand_mixx TEXT,   -- numéro Mixx by Yas / T-Money du gestionnaire (mode manuel)
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS immeubles (
  id TEXT PRIMARY KEY,
  gestionnaire_id TEXT NOT NULL,
  nom TEXT NOT NULL,
  adresse TEXT,
  FOREIGN KEY (gestionnaire_id) REFERENCES gestionnaires(id)
);

CREATE TABLE IF NOT EXISTS locataires (
  id TEXT PRIMARY KEY,
  gestionnaire_id TEXT NOT NULL,
  immeuble_id TEXT,
  nom TEXT NOT NULL,
  telephone TEXT NOT NULL,     -- numéro Flooz/T-Money pour FedaPay
  montant_loyer INTEGER NOT NULL,  -- FCFA
  jour_echeance INTEGER DEFAULT 5, -- jour du mois
  actif INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (gestionnaire_id) REFERENCES gestionnaires(id),
  FOREIGN KEY (immeuble_id) REFERENCES immeubles(id)
);

CREATE TABLE IF NOT EXISTS paiements (
  id TEXT PRIMARY KEY,
  gestionnaire_id TEXT NOT NULL,
  locataire_id TEXT NOT NULL,
  montant INTEGER NOT NULL,
  mois_concerne TEXT NOT NULL,     -- ex "2026-08"
  statut TEXT DEFAULT 'en_attente', -- en_attente | confirme | echoue
  mode TEXT DEFAULT 'fedapay',     -- fedapay (avec commission) | manuel (0% commission, numéro marchand direct)
  fedapay_transaction_id TEXT,
  fedapay_reference TEXT,
  reference_saisie TEXT,           -- référence SMS saisie par le gestionnaire (mode manuel)
  confirme_par TEXT,                -- id du gestionnaire qui a validé (mode manuel)
  moyen_paiement TEXT,             -- flooz | tmoney | carte
  recu_path TEXT,                  -- PDF généré après confirmation
  created_at TEXT DEFAULT (datetime('now')),
  confirmed_at TEXT,
  FOREIGN KEY (locataire_id) REFERENCES locataires(id)
);

CREATE INDEX IF NOT EXISTS idx_paiements_locataire ON paiements(locataire_id, mois_concerne);
CREATE INDEX IF NOT EXISTS idx_paiements_gestionnaire ON paiements(gestionnaire_id, created_at);
`);

module.exports = db;
