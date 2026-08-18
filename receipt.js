// receipt.js — Génère un reçu PDF signé après confirmation de paiement
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

// Formate un montant en FCFA avec espace normal comme séparateur de milliers
// (toLocaleString('fr-FR') utilise un espace insécable fin U+202F que la police PDF standard ne sait pas encoder)
function formatMontant(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

async function genererRecu({ gestionnaire, locataire, paiement, outputDir }) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 400]); // A5 paysage-ish, compact
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let y = 360;
  const sanitize = (s) => String(s).replace(/[\u202F\u00A0\u2009\u2007]/g, ' '); // remplace les espaces spéciaux par un espace normal
  const draw = (text, opts = {}) => {
    page.drawText(sanitize(text), { x: opts.x ?? 40, y, size: opts.size ?? 11, font: opts.bold ? fontBold : font, color: rgb(0, 0, 0) });
    y -= opts.gap ?? 20;
  };

  draw(`REÇU DE PAIEMENT DE LOYER`, { size: 16, bold: true, gap: 30 });
  draw(`Gestionnaire : ${gestionnaire.nom}`, { bold: true });
  draw(`Locataire : ${locataire.nom}`);
  draw(`Téléphone : ${locataire.telephone}`);
  draw(`Mois concerné : ${paiement.mois_concerne}`);
  draw(`Montant : ${formatMontant(paiement.montant)} FCFA`, { bold: true });
  draw(`Moyen de paiement : ${paiement.moyen_paiement || 'Mobile Money'}`);
  const reference = paiement.reference_saisie || paiement.fedapay_reference || paiement.fedapay_transaction_id || '-';
  draw(`Référence de transaction : ${reference}`);
  draw(`Date de confirmation : ${new Date(paiement.confirmed_at).toLocaleString('fr-FR')}`, { gap: 40 });

  // Insère la signature/tampon du gestionnaire si disponible (stocké en base64 dans Turso, persistant)
  if (gestionnaire.signature_data) {
    try {
      const match = gestionnaire.signature_data.match(/^data:image\/(png|jpe?g);base64,(.+)$/);
      if (match) {
        const [, format, base64] = match;
        const sigBytes = Buffer.from(base64, 'base64');
        const sigImage = format === 'png' ? await pdfDoc.embedPng(sigBytes) : await pdfDoc.embedJpg(sigBytes);
        const sigDims = sigImage.scaleToFit(120, 60);
        page.drawImage(sigImage, { x: 420, y: 40, width: sigDims.width, height: sigDims.height });
      }
    } catch (e) {
      console.error('Erreur insertion signature :', e.message); // on continue sans bloquer la génération du reçu
    }
  }

  draw(`Ce reçu est généré automatiquement et fait foi de paiement.`, { x: 40, size: 8, gap: 0 });

  const pdfBytes = await pdfDoc.save();
  const fileName = `recu_${paiement.id}.pdf`;
  const filePath = path.join(outputDir, fileName);
  fs.writeFileSync(filePath, pdfBytes);
  return filePath;
}

module.exports = { genererRecu };
