// receipt.js — Génère un reçu PDF signé après confirmation de paiement
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');
const path = require('path');

async function genererRecu({ gestionnaire, locataire, paiement, outputDir }) {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 400]); // A5 paysage-ish, compact
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let y = 360;
  const draw = (text, opts = {}) => {
    page.drawText(text, { x: opts.x ?? 40, y, size: opts.size ?? 11, font: opts.bold ? fontBold : font, color: rgb(0, 0, 0) });
    y -= opts.gap ?? 20;
  };

  draw(`REÇU DE PAIEMENT DE LOYER`, { size: 16, bold: true, gap: 30 });
  draw(`Gestionnaire : ${gestionnaire.nom}`, { bold: true });
  draw(`Locataire : ${locataire.nom}`);
  draw(`Téléphone : ${locataire.telephone}`);
  draw(`Mois concerné : ${paiement.mois_concerne}`);
  draw(`Montant : ${paiement.montant.toLocaleString('fr-FR')} FCFA`, { bold: true });
  draw(`Moyen de paiement : ${paiement.moyen_paiement || 'Mobile Money'}`);
  const reference = paiement.reference_saisie || paiement.fedapay_reference || paiement.fedapay_transaction_id || '-';
  draw(`Référence de transaction : ${reference}`);
  draw(`Date de confirmation : ${new Date(paiement.confirmed_at).toLocaleString('fr-FR')}`, { gap: 40 });

  // Insère la signature/tampon du gestionnaire si disponible (même logique que Devis Pro)
  if (gestionnaire.signature_path && fs.existsSync(gestionnaire.signature_path)) {
    const sigBytes = fs.readFileSync(gestionnaire.signature_path);
    const ext = path.extname(gestionnaire.signature_path).toLowerCase();
    const sigImage = ext === '.jpg' || ext === '.jpeg'
      ? await pdfDoc.embedJpg(sigBytes)
      : await pdfDoc.embedPng(sigBytes);
    const sigDims = sigImage.scaleToFit(120, 60);
    page.drawImage(sigImage, { x: 420, y: 40, width: sigDims.width, height: sigDims.height });
  }

  draw(`Ce reçu est généré automatiquement et fait foi de paiement.`, { x: 40, size: 8, gap: 0 });

  const pdfBytes = await pdfDoc.save();
  const fileName = `recu_${paiement.id}.pdf`;
  const filePath = path.join(outputDir, fileName);
  fs.writeFileSync(filePath, pdfBytes);
  return filePath;
}

module.exports = { genererRecu };
