// db.js — Base de données Turso (SQLite-compatible, hébergée, persiste entre les redéploiements)
const { createClient } = require('@libsql/client');

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

const SCHEMA = [
`CREATE TABLE IF NOT EXISTS gestionnaires (
  id TEXT PRIMARY KEY,
  nom TEXT NOT NULL,
  telephone TEXT,
  email TEXT,
  device_id TEXT,
  license_code TEXT,
  license_expiry TEXT,
  quota_locataires INTEGER DEFAULT 10,
  signature_path TEXT,
  numero_marchand_flooz TEXT,
  numero_marchand_mixx TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`,
`CREATE TABLE IF NOT EXISTS immeubles (
  id TEXT PRIMARY KEY,
  gestionnaire_id TEXT NOT NULL,
  nom TEXT NOT NULL,
  adresse TEXT
)`,
`CREATE TABLE IF NOT EXISTS locataires (
  id TEXT PRIMARY KEY,
  gestionnaire_id TEXT NOT NULL,
  immeuble_id TEXT,
  nom TEXT NOT NULL,
  telephone TEXT NOT NULL,
  montant_loyer INTEGER NOT NULL,
  jour_echeance INTEGER DEFAULT 5,
  actif INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
)`,
`CREATE TABLE IF NOT EXISTS paiements (
  id TEXT PRIMARY KEY,
  gestionnaire_id TEXT NOT NULL,
  locataire_id TEXT NOT NULL,
  montant INTEGER NOT NULL,
  mois_concerne TEXT NOT NULL,
  statut TEXT DEFAULT 'en_attente',
  mode TEXT DEFAULT 'fedapay',
  fedapay_transaction_id TEXT,
  fedapay_reference TEXT,
  reference_saisie TEXT,
  confirme_par TEXT,
  moyen_paiement TEXT,
  recu_path TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  confirmed_at TEXT
)`,
`CREATE INDEX IF NOT EXISTS idx_paiements_locataire ON paiements(locataire_id, mois_concerne)`,
`CREATE INDEX IF NOT EXISTS idx_paiements_gestionnaire ON paiements(gestionnaire_id, created_at)`
];

async function initSchema() {
  for (const stmt of SCHEMA) {
    await client.execute(stmt);
  }
  // Migration : ajoute la colonne signature_data si elle n'existe pas encore (stockage base64, persistant)
  try {
    await client.execute('ALTER TABLE gestionnaires ADD COLUMN signature_data TEXT');
  } catch (e) {
    // colonne déjà présente — on ignore l'erreur
  }
  try {
    await client.execute('ALTER TABLE gestionnaires ADD COLUMN suspendu INTEGER DEFAULT 0');
  } catch (e) {
    // colonne déjà présente — on ignore l'erreur
  }
}

// Petits helpers pour garder un style proche de better-sqlite3, mais en async
async function get(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows[0] || null;
}
async function all(sql, args = []) {
  const res = await client.execute({ sql, args });
  return res.rows;
}
async function run(sql, args = []) {
  return client.execute({ sql, args });
}

module.exports = { client, initSchema, get, all, run };
