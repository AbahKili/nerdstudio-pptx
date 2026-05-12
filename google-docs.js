'use strict';

// ── Google Docs API — create, write, share documents ──

const { getAccessToken } = require('./google-drive');

async function createDoc(title, content) {
  const token = await getAccessToken();

  // Upload .md file and convert to Google Doc via Drive API (no Docs API scope needed)
  const boundary = '---docboundary' + Date.now();
  const metadata = JSON.stringify({
    name: title,
    mimeType: 'application/vnd.google-apps.document',
  });

  const body = Buffer.concat([
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
    Buffer.from(metadata),
    Buffer.from(`\r\n--${boundary}\r\nContent-Type: text/markdown\r\n\r\n`),
    Buffer.from(content, 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);

  const uploadRes = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    throw new Error(`Upload failed: ${err}`);
  }

  const file = await uploadRes.json();
  const docId = file.id;

  // Make viewable by anyone with link
  await fetch(`https://www.googleapis.com/drive/v3/files/${docId}/permissions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });

  const docURL = `https://docs.google.com/document/d/${docId}/edit`;
  console.log(`[docs] Created: ${docURL}`);
  return { docId, docURL };
}

function buildRequests(content) {
  const requests = [];
  let index = 1;

  const lines = content.split('\n');
  for (const line of lines) {
    if (line.startsWith('# ')) {
      requests.push({
        insertText: { location: { index }, text: line.replace('# ', '') + '\n' },
      });
      // Make it a title
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: index, endIndex: index + line.length },
          paragraphStyle: { namedStyleType: 'HEADING_1' },
          fields: 'namedStyleType',
        },
      });
      index += line.length + 1;
    } else if (line.startsWith('## ')) {
      requests.push({
        insertText: { location: { index }, text: line.replace('## ', '') + '\n' },
      });
      requests.push({
        updateParagraphStyle: {
          range: { startIndex: index, endIndex: index + line.length },
          paragraphStyle: { namedStyleType: 'HEADING_2' },
          fields: 'namedStyleType',
        },
      });
      index += line.length + 1;
    } else if (line.startsWith('- ')) {
      requests.push({
        insertText: { location: { index }, text: line.replace('- ', '• ') + '\n' },
      });
      index += line.length + 1;
    } else if (line.trim() === '') {
      requests.push({ insertText: { location: { index }, text: '\n' } });
      index += 1;
    } else {
      requests.push({
        insertText: { location: { index }, text: line + '\n' },
      });
      index += line.length + 1;
    }
  }

  return requests;
}

async function shareWithEmail(docId, email) {
  const token = await getAccessToken();
  await fetch(`https://www.googleapis.com/drive/v3/files/${docId}/permissions?sendNotificationEmail=true`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: email }),
  });
  console.log(`[docs] Shared ${docId} with ${email}`);
}

module.exports = { createDoc, shareWithEmail };
