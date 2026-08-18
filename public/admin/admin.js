// admin.js — panneau admin LoyerPay (génération et gestion des licences)
let ADMIN_PASSWORD = sessionStorage.getItem('admin_password') || '';

function adminHeaders() {
  return { 'Content-Type': 'application/json', 'x-admin-password': ADMIN_PASSWORD };
}

async function connecter() {
  const password = document.getElementById('admin-password').value.trim();
  const res = await fetch('/api/admin/gestionnaires', { headers: { 'x-admin-password': password } });
  if (res.ok) {
    ADMIN_PASSWORD = password;
    sessionStorage.setItem('admin_password', password);
    document.getElementById('login-screen').classList.remove('visible');
    document.getElementById('app-screen').classList.add('visible');
    chargerGestionnaires();
  } else {
    document.getElementById('login-error').textContent = 'Mot de passe incorrect.';
  }
}

async function creerGestionnaire() {
  const nom = document.getElementById('new-nom').value.trim();
  const telephone = document.getElementById('new-tel').value.trim();
  const email = document.getElementById('new-email').value.trim();
  const deviceId = document.getElementById('new-device').value.trim();
  const quotaLocataires = parseInt(document.getElementById('new-quota').value, 10);
  const dureeJours = parseInt(document.getElementById('new-duree').value, 10);

  if (!nom || !deviceId || !quotaLocataires || !dureeJours) {
    return alert('Merci de remplir au moins Nom, Device ID, Quota et Durée.');
  }

  const res = await fetch('/api/admin/gestionnaires', {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({ nom, telephone, email, deviceId, quotaLocataires, dureeJours })
  });
  const data = await res.json();
  if (!res.ok) return alert('Erreur : ' + (data.error || 'inconnue'));

  document.getElementById('new-result').innerHTML = `
    <p><b>Gestionnaire créé.</b> À transmettre au client :</p>
    <p>ID gestionnaire : <code>${data.id}</code></p>
    <p>Code licence : <code>${data.licenseCode}</code></p>
    <p>Expire le : ${data.expiry}</p>`;

  ['new-nom','new-tel','new-email','new-device'].forEach(id => document.getElementById(id).value = '');
  chargerGestionnaires();
}

async function chargerGestionnaires() {
  const res = await fetch('/api/admin/gestionnaires', { headers: adminHeaders() });
  if (!res.ok) return;
  const rows = await res.json();
  document.getElementById('total-count').textContent = rows.length;
  const tbody = document.getElementById('table-gestionnaires');
  tbody.innerHTML = '';
  rows.forEach(g => {
    const tr = document.createElement('tr');
    const badge = g.expire ? `<span class="badge expire">expirée</span>` : `<span class="badge ok">active</span>`;
    tr.innerHTML = `
      <td>${g.nom}</td>
      <td>${g.telephone || '—'}<br>${g.email || ''}</td>
      <td>${g.nb_locataires} / ${g.quota_locataires}</td>
      <td>${badge}<br><span style="font-size:11px;color:#888">jusqu'au ${new Date(g.license_expiry).toLocaleDateString('fr-FR')}</span></td>
      <td><button onclick="renouveler('${g.id}')">Renouveler 1 an</button></td>`;
    tbody.appendChild(tr);
  });
}

async function renouveler(id) {
  const res = await fetch(`/api/admin/gestionnaires/${id}/renouveler`, {
    method: 'POST', headers: adminHeaders(),
    body: JSON.stringify({ dureeJours: 365 })
  });
  const data = await res.json();
  if (!res.ok) return alert('Erreur : ' + (data.error || 'inconnue'));
  alert(`Licence renouvelée jusqu'au ${data.expiry}.\nNouveau code : ${data.licenseCode}\n\nÀ transmettre au client pour qu'il le saisisse dans son app.`);
  chargerGestionnaires();
}

// Reconnexion automatique si un mot de passe est déjà en mémoire de session
if (ADMIN_PASSWORD) {
  document.getElementById('admin-password').value = ADMIN_PASSWORD;
  connecter();
}
